import { PineTS, Provider } from 'pinets';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import dotenv from 'dotenv';

import { exec } from 'child_process';

function playAlertSound(tipo: 'ENTRADA' | 'CIERRE' | 'RANGO') {
    if (process.platform === 'win32') {
        // Dos tonos agudos para entrada real, un tono medio para cierre o rango
        const psCommand = tipo === 'ENTRADA'
            ? '[console]::beep(1000, 250); Start-Sleep -Milliseconds 100; [console]::beep(1400, 350)'
            : '[console]::beep(800, 250)';
        exec(`powershell -NoProfile -Command "${psCommand}"`);
    } else {
        process.stdout.write('\x07');
    }
}

// === 0. CARGA INTELIGENTE DE .ENV ===
const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env')
];
let loadedEnvPath = 'Variables de entorno del sistema';
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        loadedEnvPath = p;
        break;
    }
}

// === 1. LECTURA Y VALIDACIÓN DE VARIABLES DE ENTORNO ===
let autoTradeActive = process.env.AUTO_TRADE?.trim().toLowerCase() === 'true';
const USE_TESTNET = process.env.USE_TESTNET?.trim().toLowerCase() !== 'false';
const API_KEY = (process.env.BINANCE_API_KEY || '').trim();
const API_SECRET = (process.env.BINANCE_API_SECRET || '').trim();

const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL_USDT) || 100.0;
const RISK_PCT = Number(process.env.RISK_PER_TRADE_PCT) || 2.0;
const LEVERAGE = Math.min(Math.max(Math.round(Number(process.env.LEVERAGE) || 10), 1), 125);
const MARGIN_TYPE = (process.env.MARGIN_TYPE || 'ISOLATED').trim().toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED';

const BINANCE_FAPI_BASE = USE_TESTNET
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '5m';
const CANDLES_LIMIT = 200;
const POLL_INTERVAL_SEC = 15;
const CSV_FILENAME = path.join(process.cwd(), 'elon_btcusdt_v2_trades.csv');

if (INITIAL_CAPITAL <= 0 || RISK_PCT <= 0 || RISK_PCT > 100) {
    console.error('❌ ERROR CRÍTICO: Verifica INITIAL_CAPITAL_USDT y RISK_PER_TRADE_PCT en tus variables de entorno.');
    process.exit(1);
}

// === 2. CÓDIGO PINE SCRIPT V5 ===
const elonPineCode = `
//@version=5
indicator("ELON 24/7 Dinámico v2 - BTCUSDT", overlay=true)

rangeBars       = input.int(2, "Velas para Rango (2 en 5m = 10 min)")
maxWaitBars     = input.int(9, "Velas Máximas Espera Ruptura (9 en 5m = 45 min)")
tpMult          = input.float(0.60, "Multiplicador Take Profit (x Rango)")
slMult          = input.float(0.40, "Multiplicador Stop Loss (x Rango)")
capitalUSD      = input.float(${INITIAL_CAPITAL}, "Capital Base (USD)")
riskPct         = input.float(${RISK_PCT}, "Riesgo por Operación (%)")
minRangePct     = input.float(0.15, "Rango Mínimo (% del precio)")

var float activeHigh  = na
var float activeLow   = na
var int   barsWaiting = 0
var bool  cycleActive = false
var int   posDir      = 0
var float entryPrice  = na
var float tpPrice     = na
var float slPrice     = na
var float equity      = capitalUSD

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

if posDir == 0 and not cycleActive
    candHigh = ta.highest(high, rangeBars)
    candLow  = ta.lowest(low, rangeBars)
    candPct  = ((candHigh - candLow) / close) * 100.0
    if candPct >= minRangePct
        activeHigh  := candHigh
        activeLow   := candLow
        barsWaiting := 0
        cycleActive := true

curRange      = activeHigh - activeLow
tpDist        = curRange * tpMult
slDist        = curRange * slMult
riskAmountUSD = capitalUSD * (riskPct / 100.0)
posSizeBTC    = slDist > 0 ? (riskAmountUSD / slDist) : 0.0

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

// === 3. CLIENTE REST FIRMADO PARA BINANCE FUTURES ===
async function binanceRequest(endpoint: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, string | number> = {}) {
    const timestamp = Date.now();
    const queryParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        queryParams.append(k, String(v));
    }
    queryParams.append('timestamp', String(timestamp));
    queryParams.append('recvWindow', '5000');

    const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(queryParams.toString())
        .digest('hex');

    queryParams.append('signature', signature);

    const url = `${BINANCE_FAPI_BASE}${endpoint}?${queryParams.toString()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            method,
            headers: {
                'X-MBX-APIKEY': API_KEY,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(`Binance API Error [${data.code}]: ${data.msg}`);
        }
        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function initBinanceFutures() {
    if (!autoTradeActive) return;

    if (!API_KEY || !API_SECRET) {
        console.warn(`\n⚠️ ADVERTENCIA: AUTO_TRADE=true pero faltan BINANCE_API_KEY o BINANCE_API_SECRET.`);
        console.warn(`   -> Continuando en MODO SOLO MONITOREO + CSV.\n`);
        autoTradeActive = false;
        return;
    }

    console.log(`\n🔌 Conectando a Binance Futures (${USE_TESTNET ? 'MODO DEMO / TESTNET' : '⚠️ CUENTA REAL'})...`);
    try {
        const balances = await binanceRequest('/fapi/v2/balance', 'GET');
        const usdtAsset = balances.find((b: any) => b.asset === 'USDT');
        const availableUsdt = usdtAsset ? Number(usdtAsset.availableBalance) : 0;
        console.log(`   ✔ Conexión verificada. Saldo disponible en Binance: ${availableUsdt.toFixed(2)} USDT`);

        try {
            await binanceRequest('/fapi/v1/marginType', 'POST', { symbol: SYMBOL, marginType: MARGIN_TYPE });
            console.log(`   ✔ Tipo de margen fijado en: ${MARGIN_TYPE}`);
        } catch (e: any) {
            if (!e.message.includes('-4046')) throw e;
            console.log(`   ✔ Tipo de margen ya estaba en: ${MARGIN_TYPE}`);
        }

        await binanceRequest('/fapi/v1/leverage', 'POST', { symbol: SYMBOL, leverage: LEVERAGE });
        console.log(`   ✔ Apalancamiento configurado en: ${LEVERAGE}x para ${SYMBOL}\n`);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ NO SE PUDO CONECTAR CON EL API DE BINANCE:`);
        console.error(`   Motivo: ${reason}`);
        console.warn(`   🛡️ FALLBACK ACTIVADO: El script continuará ejecutándose en MODO SOLO SEÑALES + CSV.\n`);
        autoTradeActive = false;
    }
}

function calculateSafeBtcQty(rawQtyBtc: number, entryPrice: number): number {
    const maxNotional = INITIAL_CAPITAL * LEVERAGE * 0.95;
    const maxBtcAllowed = maxNotional / entryPrice;
    const cappedQty = Math.min(rawQtyBtc, maxBtcAllowed);
    return Math.floor(cappedQty * 1000) / 1000;
}

// Ejecución con corrección de sincronización de posición, avgPrice y manejo de error -2021
async function executeBinanceOrder(direction: 'LONG' | 'SHORT', rawQtyBtc: number, entryPrice: number, tpPrice: number, slPrice: number): Promise<string> {
    if (!autoTradeActive) return 'SIMULADO_SOLO_LECTURA';

    const qty = calculateSafeBtcQty(rawQtyBtc, entryPrice);
    const notional = qty * entryPrice;

    if (qty < 0.001 || notional < 100) {
        const msg = `OMITIDA_POR_MINIMO (Qty: ${qty} BTC, Notional: ${notional.toFixed(2)} USDT < 100 USDT)`;
        console.warn(`⚠️ Orden no enviada a Binance: ${msg}`);
        return msg;
    }

    const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';

    try {
        // Limpieza previa de órdenes pendientes
        await binanceRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol: SYMBOL }).catch(() => {});
        await binanceRequest('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: SYMBOL }).catch(() => {});

        // 1. Enviar orden a Mercado
        const orderRes = await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: SYMBOL,
            side: entrySide,
            type: 'MARKET',
            quantity: qty
        });

        // 2. Esperar medio segundo y verificar que la posición ya esté asentada en Binance
        await new Promise((resolve) => setTimeout(resolve, 500));
        const positions = await binanceRequest('/fapi/v2/positionRisk', 'GET', { symbol: SYMBOL });
        const pos = positions.find((p: any) => p.symbol === SYMBOL);
        const realEntry = pos && Number(pos.entryPrice) > 0 ? Number(pos.entryPrice) : (Number(orderRes.avgPrice) > 0 ? Number(orderRes.avgPrice) : entryPrice);

        // 3. Recalcular distancias estrictas con el precio real de llenado
        const tpDist = Math.abs(tpPrice - entryPrice);
        const slDist = Math.abs(entryPrice - slPrice);

        const realTp = direction === 'LONG' ? realEntry + tpDist : realEntry - tpDist;
        const realSl = direction === 'LONG' ? realEntry - slDist : realEntry + slDist;

        const tpFormatted = realTp.toFixed(1);
        const slFormatted = realSl.toFixed(1);

        // 4. Enviar Stop Loss (Algoritmo condicional)
        try {
            await binanceRequest('/fapi/v1/algoOrder', 'POST', {
                algoType: 'CONDITIONAL',
                symbol: SYMBOL,
                side: exitSide,
                type: 'STOP_MARKET',
                triggerPrice: slFormatted,
                closePosition: 'true',
                workingType: 'MARK_PRICE'
            });
        } catch (slErr: any) {
            // Si da error -2021 (el precio ya cruzó el SL), cerrar la posición inmediatamente por seguridad
            if (slErr.message?.includes('-2021')) {
                console.warn(`⚠️ SL ya cruzado (-2021). Cerrando posición de emergencia a mercado...`);
                await binanceRequest('/fapi/v1/order', 'POST', {
                    symbol: SYMBOL,
                    side: exitSide,
                    type: 'MARKET',
                    quantity: qty
                });
                return `CERRADA_EMERGENCIA_SL_CRUZADO`;
            }
            throw slErr;
        }

        // 5. Enviar Take Profit (Algoritmo condicional)
        try {
            await binanceRequest('/fapi/v1/algoOrder', 'POST', {
                algoType: 'CONDITIONAL',
                symbol: SYMBOL,
                side: exitSide,
                type: 'TAKE_PROFIT_MARKET',
                triggerPrice: tpFormatted,
                closePosition: 'true',
                workingType: 'MARK_PRICE'
            });
        } catch (tpErr: any) {
            if (tpErr.message?.includes('-2021')) {
                console.warn(`⚠️ TP ya cruzado (-2021). Cerrando posición de emergencia a mercado...`);
                await binanceRequest('/fapi/v1/order', 'POST', {
                    symbol: SYMBOL,
                    side: exitSide,
                    type: 'MARKET',
                    quantity: qty
                });
                return `CERRADA_EMERGENCIA_TP_CRUZADO`;
            }
            throw tpErr;
        }

        console.log(`🚀 ORDEN BINANCE EJECUTADA [ID: ${orderRes.orderId}] | ${entrySide} ${qty} BTC @ ${realEntry.toFixed(1)} | TP: ${tpFormatted} | SL: ${slFormatted}`);
        return `EJECUTADA_ID_${orderRes.orderId}_QTY_${qty}_ENTRY_${realEntry.toFixed(1)}`;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Error enviando orden a Binance:`, errMsg);
        return `ERROR_API: ${errMsg}`;
    }
}

// === 4. REGISTRO Y AUDITORÍA CSV ===
function initCsv() {
    if (!fs.existsSync(CSV_FILENAME)) {
        const headers = [
            'Fecha_Hora',
            'Modo_Ejecucion',
            'Evento',
            'Direccion',
            'Precio_BTC_Actual',
            'Precio_Entrada',
            'Take_Profit',
            'Stop_Loss',
            'Tamano_Calculado_BTC',
            'Estado_Orden_Binance',
            'Resultado_Estimado_USD',
            'Equity_Simulado_USD'
        ].join(',') + '\n';
        fs.writeFileSync(CSV_FILENAME, headers, 'utf8');
    }
}

function logTradeToCsv(row: {
    evento: string;
    direccion: string;
    precioActual: number;
    entrada: number | null;
    tp: number | null;
    sl: number | null;
    tamanoBtc: number;
    estadoBinance: string;
    resultadoUsd: number;
    equityUsd: number;
}) {
    const now = new Date();
    const timestamp = `${now.toLocaleDateString('es-VE')} ${now.toLocaleTimeString('es-VE', { hour12: false })}`;
    const modo = autoTradeActive ? (USE_TESTNET ? 'AUTO_DEMO' : 'AUTO_REAL') : 'SOLO_MONITOR';

    const line = [
        `"${timestamp}"`,
        modo,
        row.evento,
        row.direccion,
        row.precioActual.toFixed(2),
        row.entrada !== null ? row.entrada.toFixed(2) : '',
        row.tp !== null ? row.tp.toFixed(2) : '',
        row.sl !== null ? row.sl.toFixed(2) : '',
        row.tamanoBtc.toFixed(4),
        `"${row.estadoBinance}"`,
        row.resultadoUsd.toFixed(2),
        row.equityUsd.toFixed(2)
    ].join(',') + '\n';

    fs.appendFileSync(CSV_FILENAME, line, 'utf8');
}

// === 5. BUCLE PRINCIPAL DE MONITOREO ===
let prevStateKey = '';
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

        const posDir = getLast('PositionDir') ?? 0;
        const trigLong = getLast('TriggerLong');
        const trigShort = getLast('TriggerShort');
        const entry = getLast('EntryPrice');
        const tp = getLast('TakeProfit');
        const sl = getLast('StopLoss');
        const sizeBtc = getLast('SizeBTC') ?? 0;
        const equity = getLast('EquityUSD') ?? 0;
        const lastClose = getLast('LastClose') ?? 0;

        if (prevPosDir !== null && prevPosDir !== 0 && posDir === 0) {
            const diffUsd = prevEquity !== null ? equity - prevEquity : 0;
            const tipoCierre = diffUsd >= 0 ? 'CIERRE_TP' : 'CIERRE_SL';
            const dirAnterior = prevPosDir === 1 ? 'LONG' : 'SHORT';

            logTradeToCsv({
                evento: tipoCierre,
                direccion: dirAnterior,
                precioActual: lastClose,
                entrada: entry,
                tp,
                sl,
                tamanoBtc: 0,
                estadoBinance: autoTradeActive ? 'CERRADA_POR_TP_SL_EXCHANGE' : 'SIMULADA',
                resultadoUsd: diffUsd,
                equityUsd: equity
            });
            console.log(`\n[${formatTime()}] 📝 CSV: ${tipoCierre} (${dirAnterior}) | PnL Est.: ${diffUsd >= 0 ? '+' : ''}${diffUsd.toFixed(2)} USD`);
        }

        if (prevPosDir !== null && posDir !== 0 && posDir !== prevPosDir && entry !== null && tp !== null && sl !== null) {
            const dirNueva = posDir === 1 ? 'LONG' : 'SHORT';
            const estadoOrden = await executeBinanceOrder(dirNueva, sizeBtc, entry, tp, sl);

            logTradeToCsv({
                evento: `ENTRY_${dirNueva}`,
                direccion: dirNueva,
                precioActual: lastClose,
                entrada: entry,
                tp,
                sl,
                tamanoBtc: sizeBtc,
                estadoBinance: estadoOrden,
                resultadoUsd: 0,
                equityUsd: equity
            });
            playAlertSound('ENTRADA');
            console.log(`\n[${formatTime()}] 📝 CSV: ENTRY_${dirNueva} @ ${entry.toFixed(2)} | Estado: ${estadoOrden}`);
        }

        const currentStateKey = `${posDir}_${trigLong?.toFixed(2)}_${trigShort?.toFixed(2)}`;
        const estadoTexto = posDir === 1
            ? '🟢 EN POSICIÓN LONG'
            : posDir === -1
            ? '🔴 EN POSICIÓN SHORT'
            : trigLong !== null
            ? '🟡 ESPERANDO RUPTURA'
            : '⚪ BUSCANDO RANGO';

        if (currentStateKey !== prevStateKey) {
            process.stdout.write('\x07');
            console.log(`\n======================================================`);
            console.log(`[${formatTime()}] 🔔 CAMBIO DE ESTADO -> ${estadoTexto}`);
            console.log(`Modo: ${autoTradeActive ? (USE_TESTNET ? 'AUTO-TRADE DEMO' : 'AUTO-TRADE REAL') : 'SOLO MONITOREO'} | Capital: $${INITIAL_CAPITAL} | Lev: ${LEVERAGE}x`);
            console.log(`Precio Actual BTC: ${lastClose.toFixed(2)} USDT`);
            console.log(`------------------------------------------------------`);
            if (posDir !== 0 && entry !== null && tp !== null && sl !== null) {
                const safeQty = calculateSafeBtcQty(sizeBtc, entry);
                console.log(`Entrada Ejecutada: ${entry.toFixed(2)} USDT`);
                console.log(`Take Profit (TP):  ${tp.toFixed(2)} USDT`);
                console.log(`Stop Loss (SL):    ${sl.toFixed(2)} USDT`);
                console.log(`Tamaño Ajustado:   ${safeQty.toFixed(3)} BTC (Notional: ${(safeQty * entry).toFixed(2)} USDT)`);
            } else if (trigLong !== null && trigShort !== null) {
                const rango = trigLong - trigShort;
                console.log(`Trigger LONG:      ${trigLong.toFixed(2)} | TP: ${(trigLong + rango * 0.60).toFixed(2)} | SL: ${(trigLong - rango * 0.40).toFixed(2)}`);
                console.log(`Trigger SHORT:     ${trigShort.toFixed(2)} | TP: ${(trigShort - rango * 0.60).toFixed(2)} | SL: ${(trigShort + rango * 0.40).toFixed(2)}`);
                console.log(`Rango Actual:      ${rango.toFixed(2)} USD`);
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
        console.error(`\n[${formatTime()}] Error en ciclo de monitoreo:`, err instanceof Error ? err.message : err);
    } finally {
        isRunning = false;
    }
}

async function bootstrap() {
    initCsv();
    await initBinanceFutures();

    console.log('======================================================');
    console.log('   ELON BTCUSDT v2 - MONITOR Y EJECUCIÓN BINANCE');
    console.log('======================================================');
    console.log(`• Archivo Config:     ${loadedEnvPath}`);
    console.log(`• Modo Auto-Trade:    ${autoTradeActive ? 'ACTIVADO' : 'DESACTIVADO (Solo señales + CSV)'}`);
    console.log(`• Entorno Binance:    ${USE_TESTNET ? 'DEMO / TESTNET (testnet.binancefuture.com)' : '⚠️ PRODUCCIÓN REAL (fapi.binance.com)'}`);
    console.log(`• Capital Base:       $${INITIAL_CAPITAL.toFixed(2)} USDT`);
    console.log(`• Riesgo por Trade:   ${RISK_PCT}% ($${(INITIAL_CAPITAL * (RISK_PCT / 100)).toFixed(2)} USDT max loss)`);
    console.log(`• Apalancamiento:     ${LEVERAGE}x (${MARGIN_TYPE})`);
    console.log('======================================================');

    checkMarket();
    setInterval(checkMarket, POLL_INTERVAL_SEC * 1000);
}

bootstrap();