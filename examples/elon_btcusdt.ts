import { PineTS, Provider } from 'pinets';
import * as fs from 'fs';
import * as path from 'path';

// === CONFIGURACIÓN DEL MONITOR Y AUDITORÍA CSV ===
const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '5m';
const CANDLES_LIMIT = 200;
const POLL_INTERVAL_SEC = 15;
const CSV_FILENAME = path.join(process.cwd(), 'elon_btcusdt_trades.csv');

// Código Pine Script v5 adaptado para monitoreo continuo
const elonPineCode = `
//@version=5
indicator("ELON 24/7 Dinámico - BTCUSDT", overlay=true)

// === PARÁMETROS ===
rangeBars       = input.int(2, "Velas para Rango (2 en 5m = 10 min)")
maxWaitBars     = input.int(9, "Velas Máximas Espera Ruptura (9 en 5m = 45 min)")
tpMult          = input.float(0.60, "Multiplicador Take Profit (x Rango)")
slMult          = input.float(0.40, "Multiplicador Stop Loss (x Rango)")
capitalUSD      = input.float(1000.0, "Capital Base (USD)")
riskPct         = input.float(2.0, "Riesgo por Operación (%)")
minRangePct     = input.float(0.15, "Rango Mínimo (% del precio)")

// === VARIABLES DE ESTADO ===
var float activeHigh  = na
var float activeLow   = na
var int   barsWaiting = 0
var bool  cycleActive = false
var int   posDir      = 0     // 0 = Sin posición, 1 = Long, -1 = Short
var float entryPrice  = na
var float tpPrice     = na
var float slPrice     = na
var float equity      = capitalUSD

// === 1. GESTIÓN DE POSICIÓN ABIERTA (EVALUACIÓN TP / SL) ===
if posDir == 1
    if low <= slPrice
        equity := equity - (equity * (riskPct / 100.0))
        posDir := 0
    else if high >= tpPrice
        equity := equity + (equity * (riskPct / 100.0) * (tpMult / slMult))
        posDir := 0

else if posDir == -1
    if high >= slPrice
        equity := equity - (equity * (riskPct / 100.0))
        posDir := 0
    else if low <= tpPrice
        equity := equity + (equity * (riskPct / 100.0) * (tpMult / slMult))
        posDir := 0

// === 2. INICIAR NUEVO RANGO SI NO HAY POSICIÓN NI CICLO ACTIVO ===
if posDir == 0 and not cycleActive
    candHigh = ta.highest(high, rangeBars)
    candLow  = ta.lowest(low, rangeBars)
    candPct  = ((candHigh - candLow) / close) * 100.0
    
    if candPct >= minRangePct
        activeHigh  := candHigh
        activeLow   := candLow
        barsWaiting := 0
        cycleActive := true

// === 3. CÁLCULO DE DISTANCIAS Y LOTAJE ===
curRange      = activeHigh - activeLow
tpDist        = curRange * tpMult
slDist        = curRange * slMult
riskAmountUSD = equity * (riskPct / 100.0)
posSizeBTC    = slDist > 0 ? (riskAmountUSD / slDist) : 0.0

// === 4. DETECCIÓN DE RUPTURA (ENTRADA) ===
if cycleActive and posDir == 0
    if barsWaiting < maxWaitBars and curRange > 0 and posSizeBTC > 0
        if high >= activeHigh
            posDir      := 1
            entryPrice  := activeHigh
            tpPrice     := entryPrice + tpDist
            slPrice     := entryPrice - slDist
            cycleActive := false
        else if low <= activeLow
            posDir      := -1
            entryPrice  := activeLow
            tpPrice     := entryPrice - tpDist
            slPrice     := entryPrice + slDist
            cycleActive := false
        else
            barsWaiting += 1
    else
        cycleActive := false
        activeHigh  := na
        activeLow   := na

// === SALIDAS PARA LECTURA EN NODE.JS ===
plot(activeHigh, "TriggerLong")
plot(activeLow, "TriggerShort")
plot(posDir, "PositionDir")
plot(entryPrice, "EntryPrice")
plot(tpPrice, "TakeProfit")
plot(slPrice, "StopLoss")
plot(posSizeBTC, "SizeBTC")
plot(equity, "EquityUSD")
plot(close, "LastClose")
`;

// Inicializa el archivo CSV con encabezados si aún no existe
function initCsv() {
    if (!fs.existsSync(CSV_FILENAME)) {
        const headers = [
            'Fecha_Hora',
            'Evento',
            'Direccion',
            'Precio_BTC_Actual',
            'Precio_Entrada',
            'Take_Profit',
            'Stop_Loss',
            'Tamano_BTC',
            'Resultado_Estimado_USD',
            'Equity_Simulado_USD'
        ].join(',') + '\n';
        fs.writeFileSync(CSV_FILENAME, headers, 'utf8');
        console.log(`Archivo de auditoría creado en: ${CSV_FILENAME}`);
    } else {
        console.log(`Registrando operaciones en archivo existente: ${CSV_FILENAME}`);
    }
}

// Guarda una fila en el CSV
function logTradeToCsv(row: {
    evento: string;
    direccion: string;
    precioActual: number;
    entrada: number | null;
    tp: number | null;
    sl: number | null;
    tamanoBtc: number;
    resultadoUsd: number;
    equityUsd: number;
}) {
    const now = new Date();
    const timestamp = `${now.toLocaleDateString('es-VE')} ${now.toLocaleTimeString('es-VE', { hour12: false })}`;

    const line = [
        `"${timestamp}"`,
        row.evento,
        row.direccion,
        row.precioActual.toFixed(2),
        row.entrada !== null ? row.entrada.toFixed(2) : '',
        row.tp !== null ? row.tp.toFixed(2) : '',
        row.sl !== null ? row.sl.toFixed(2) : '',
        row.tamanoBtc.toFixed(4),
        row.resultadoUsd.toFixed(2),
        row.equityUsd.toFixed(2)
    ].join(',') + '\n';

    fs.appendFileSync(CSV_FILENAME, line, 'utf8');
}

// Variables de control de estado entre lecturas
let prevStateKey = "";
let prevPosDir: number | null = null;
let prevEquity: number | null = null;
let isRunning = false;

function formatTime(): string {
    return new Date().toLocaleTimeString('es-VE', { hour12: false });
}

async function checkMarket() {
    if (isRunning) return;
    isRunning = true;

    try {
        const pineTS = new PineTS(Provider.Binance, SYMBOL, TIMEFRAME, CANDLES_LIMIT);
        const { plots } = await pineTS.run(elonPineCode);

        const getLast = (plotName: string): number | null => {
            const series = plots[plotName]?.data;
            if (!series || series.length === 0) return null;
            const val = series[series.length - 1].value;
            return val !== null && !Number.isNaN(Number(val)) ? Number(val) : null;
        };

        const posDir = getLast("PositionDir") ?? 0;
        const trigLong = getLast("TriggerLong");
        const trigShort = getLast("TriggerShort");
        const entry = getLast("EntryPrice");
        const tp = getLast("TakeProfit");
        const sl = getLast("StopLoss");
        const sizeBtc = getLast("SizeBTC") ?? 0;
        const equity = getLast("EquityUSD") ?? 0;
        const lastClose = getLast("LastClose") ?? 0;

        // 1. Detectar si se cerró una operación que estaba abierta en la lectura anterior
        if (prevPosDir !== null && prevPosDir !== 0 && posDir === 0) {
            const diffUsd = prevEquity !== null ? equity - prevEquity : 0;
            const tipoCierre = diffUsd >= 0 ? "CIERRE_TP (GANANCIA)" : "CIERRE_SL (PERDIDA)";
            const dirAnterior = prevPosDir === 1 ? "LONG" : "SHORT";

            logTradeToCsv({
                evento: tipoCierre,
                direccion: dirAnterior,
                precioActual: lastClose,
                entrada: entry,
                tp: tp,
                sl: sl,
                tamanoBtc: 0,
                resultadoUsd: diffUsd,
                equityUsd: equity
            });
            console.log(`\n[${formatTime()}] 📝 CSV Registrado: ${tipoCierre} (${dirAnterior}) | PnL: ${diffUsd >= 0 ? '+' : ''}${diffUsd.toFixed(2)} USD`);
        }

        // 2. Detectar si se abrió una nueva posición respecto a la lectura anterior
        if (prevPosDir !== null && posDir !== 0 && posDir !== prevPosDir) {
            const dirNueva = posDir === 1 ? "LONG" : "SHORT";
            logTradeToCsv({
                evento: `ENTRY_${dirNueva}`,
                direccion: dirNueva,
                precioActual: lastClose,
                entrada: entry,
                tp: tp,
                sl: sl,
                tamanoBtc: sizeBtc,
                resultadoUsd: 0,
                equityUsd: equity
            });
            console.log(`\n[${formatTime()}] 📝 CSV Registrado: ENTRY_${dirNueva} @ ${entry?.toFixed(2)}`);
        }

        const currentStateKey = `${posDir}_${trigLong?.toFixed(2)}_${trigShort?.toFixed(2)}`;
        const estadoTexto = posDir === 1
            ? "🟢 EN POSICIÓN LONG"
            : posDir === -1
            ? "🔴 EN POSICIÓN SHORT"
            : trigLong !== null
            ? "🟡 ESPERANDO RUPTURA"
            : "⚪ BUSCANDO RANGO VÁLIDO";

        if (currentStateKey !== prevStateKey) {
            process.stdout.write('\x07');
            console.log(`\n======================================================`);
            console.log(`[${formatTime()}] 🔔 CAMBIO DE ESTADO -> ${estadoTexto}`);
            console.log(`Precio Actual BTC: ${lastClose.toFixed(2)} USDT`);
            console.log(`------------------------------------------------------`);
            if (posDir !== 0 && entry !== null && tp !== null && sl !== null) {
                console.log(`Entrada Ejecutada: ${entry.toFixed(2)} USDT`);
                console.log(`Take Profit (TP):  ${tp.toFixed(2)} USDT`);
                console.log(`Stop Loss (SL):    ${sl.toFixed(2)} USDT`);
                console.log(`Tamaño Orden:      ${sizeBtc.toFixed(4)} BTC`);
            } else if (trigLong !== null && trigShort !== null) {
                const rango = trigLong - trigShort;
                const tpLong = trigLong + rango * 0.60;
                const slLong = trigLong - rango * 0.40;
                const tpShort = trigShort - rango * 0.60;
                const slShort = trigShort + rango * 0.40;

                console.log(`Trigger LONG:      ${trigLong.toFixed(2)}  | TP: ${tpLong.toFixed(2)} | SL: ${slLong.toFixed(2)}`);
                console.log(`Trigger SHORT:     ${trigShort.toFixed(2)}  | TP: ${tpShort.toFixed(2)} | SL: ${slShort.toFixed(2)}`);
                console.log(`Tamaño Sugerido:   ${sizeBtc.toFixed(4)} BTC (Rango: ${rango.toFixed(2)} USD)`);
            }
            console.log(`Equity Simulado:   ${equity.toFixed(2)} USD`);
            console.log(`======================================================\n`);
            prevStateKey = currentStateKey;
        } else {
            process.stdout.write(
                `\r[${formatTime()}] BTC: ${lastClose.toFixed(2)} | ${estadoTexto} | Long: ${trigLong?.toFixed(2) ?? '-'} | Short: ${trigShort?.toFixed(2) ?? '-'}   `
            );
        }

        prevPosDir = posDir;
        prevEquity = equity;

    } catch (err) {
        console.error(`\n[${formatTime()}] Error consultando Binance:`, err instanceof Error ? err.message : err);
    } finally {
        isRunning = false;
    }
}

initCsv();
console.log(`Iniciando monitor continuo ELON para ${SYMBOL} (${TIMEFRAME}) cada ${POLL_INTERVAL_SEC}s...`);
console.log(`Presiona Ctrl + C para detener.\n`);

checkMarket();
setInterval(checkMarket, POLL_INTERVAL_SEC * 1000);