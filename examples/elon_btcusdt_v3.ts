import { PineTS, Provider } from 'pinets';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import dotenv from 'dotenv';

import { unlockMachineCredentials } from './securityVault';

// Variables en memoria (nunca expuestas en .env en texto plano)
let API_KEY = '';
let API_SECRET = '';

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

// === 1. CONFIGURACIÓN Y PARÁMETROS ÓPTIMOS ===
let autoTradeActive = process.env.AUTO_TRADE?.trim().toLowerCase() === 'true';
const USE_TESTNET = process.env.USE_TESTNET?.trim().toLowerCase() !== 'false';
//const API_KEY = (process.env.BINANCE_API_KEY || '').trim();
//const API_SECRET = (process.env.BINANCE_API_SECRET || '').trim();

const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL_USDT) || 100.0;
const RISK_PCT = Number(process.env.RISK_PER_TRADE_PCT) || 2.0;
const LEVERAGE = Math.min(Math.max(Math.round(Number(process.env.LEVERAGE) || 5), 1), 125);
const MARGIN_TYPE = (process.env.MARGIN_TYPE || 'ISOLATED').trim().toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED';

// Parámetros de Estrategia (Ajustados para 5m BTCUSDT)
const MIN_RANGE_PCT = 0.20;      // 0.20% (~$125 en BTC: filtra ruido y cubre comisiones)
const TP_MULT = 0.90;            // Take Profit = 0.90x del rango
const SL_MULT = 0.50;            // Stop Loss = 0.50x del rango (Ratio 1.8 : 1)
const MAX_WAIT_MINUTES = 40;     // Renueva el rango si no rompe en 40 minutos

const BINANCE_FAPI_BASE = USE_TESTNET
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '5m';
const CANDLES_LIMIT = 100;
const POLL_INTERVAL_SEC = 15;
const CSV_FILENAME = path.join(process.cwd(), 'elon_btcusdt_v3_trades.csv');

if (INITIAL_CAPITAL <= 0 || RISK_PCT <= 0 || RISK_PCT > 100) {
    console.error('❌ ERROR CRÍTICO: Verifica INITIAL_CAPITAL_USDT y RISK_PER_TRADE_PCT en .env');
    process.exit(1);
}

// === ALERTA SONORA NATIVA EN WINDOWS ===
function playAlertSound(tipo: 'ENTRADA' | 'CIERRE') {
    if (process.platform === 'win32') {
        const psCommand = tipo === 'ENTRADA'
            ? '[console]::beep(1000, 220); Start-Sleep -Milliseconds 80; [console]::beep(1450, 320)'
            : '[console]::beep(750, 300)';
        exec(`powershell -NoProfile -Command "${psCommand}"`);
    } else {
        process.stdout.write('\x07');
    }
}

// === 2. INDICADORES PUROS EN PINE SCRIPT V5 (SIN ESTADO HISTÓRICO CONGELADO) ===
const elonIndicatorsPine = `
//@version=5
indicator("ELON Indicadores Tiempo Real", overlay=true)

ema50     = ta.ema(close, 50)
// Rango consolidado de las últimas 3 velas cerradas (15 minutos)
boxHigh   = ta.highest(high[1], 3)
boxLow    = ta.lowest(low[1], 3)

plot(ema50, "EMA50")
plot(boxHigh, "BoxHigh")
plot(boxLow, "BoxLow")
plot(close, "LastClose")
plot(high, "CurHigh")
plot(low, "CurLow")
`;

// === 3. CLIENTE REST BINANCE FUTURES ===
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

async function getRealBinancePosition(): Promise<{ amt: number; entryPrice: number; unRealizedProfit: number }> {
    const positions = await binanceRequest('/fapi/v2/positionRisk', 'GET', { symbol: SYMBOL });
    const pos = positions.find((p: any) => p.symbol === SYMBOL);
    return {
        amt: pos ? Number(pos.positionAmt) : 0,
        entryPrice: pos ? Number(pos.entryPrice) : 0,
        unRealizedProfit: pos ? Number(pos.unRealizedProfit) : 0
    };
}

async function fetchLastClosedTradeAccounting(openTimestampMs: number): Promise<{ grossPnl: number; totalFees: number; netPnl: number }> {
    try {
        const trades = await binanceRequest('/fapi/v1/userTrades', 'GET', {
            symbol: SYMBOL,
            startTime: Math.max(openTimestampMs - 5000, 0),
            limit: 20
        });
        let grossPnl = 0;
        let totalFees = 0;
        for (const t of trades) {
            grossPnl += Number(t.realizedPnl || 0);
            totalFees += Number(t.commission || 0);
        }
        return { grossPnl, totalFees, netPnl: grossPnl - totalFees };
    } catch {
        return { grossPnl: 0, totalFees: 0, netPnl: 0 };
    }
}

async function initBinanceFutures() {

if (!autoTradeActive) return;

    try {
        const creds = await unlockMachineCredentials();
        API_KEY = creds.apiKey;
        API_SECRET = creds.apiSecret;
        console.log('🔐 Bóveda desbloqueada: Hardware e IP verificados correctamente.');
    } catch (secErr) {
        const msg = secErr instanceof Error ? secErr.message : String(secErr);
        console.error(`\n🚨 ALERTA DE SEGURIDAD: ${msg}`);
        console.warn('   -> Por seguridad, AUTO_TRADE ha sido desactivado. Ejecutando en MODO SOLO MONITOREO.\n');
        autoTradeActive = false;
        return;
    }

    if (!autoTradeActive) return;

    if (!API_KEY || !API_SECRET) {
        console.warn(`\n⚠️ ADVERTENCIA: AUTO_TRADE=true pero faltan credenciales API. Continuando en MODO MONITOR.\n`);
        autoTradeActive = false;
        return;
    }

    console.log(`\n🔌 Conectando a Binance Futures (${USE_TESTNET ? 'MODO DEMO / TESTNET' : '⚠️ CUENTA REAL'})...`);
    try {
        const balances = await binanceRequest('/fapi/v2/balance', 'GET');
        const usdtAsset = balances.find((b: any) => b.asset === 'USDT');
        const availableUsdt = usdtAsset ? Number(usdtAsset.availableBalance) : 0;
        console.log(`   ✔ Conexión verificada. Saldo disponible: ${availableUsdt.toFixed(2)} USDT`);

        try {
            await binanceRequest('/fapi/v1/marginType', 'POST', { symbol: SYMBOL, marginType: MARGIN_TYPE });
        } catch (e: any) {
            if (!e.message.includes('-4046')) throw e;
        }
        await binanceRequest('/fapi/v1/leverage', 'POST', { symbol: SYMBOL, leverage: LEVERAGE });
        console.log(`   ✔ Margen ${MARGIN_TYPE} | Apalancamiento: ${LEVERAGE}x`);

        const currentPos = await getRealBinancePosition();
        if (currentPos.amt !== 0) {
            console.log(`   ⚠️ Posición abierta detectada: ${currentPos.amt} BTC @ ${currentPos.entryPrice.toFixed(1)}\n`);
        } else {
            console.log(`   ✔ Sin posiciones abiertas. Escaneando ruptura en tiempo real...\n`);
        }
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ ERROR BINANCE: ${reason}. Cambiando a MODO SOLO MONITOREO.\n`);
        autoTradeActive = false;
    }
}

function calculateSafeBtcQty(slDist: number, entryPrice: number): number {
    const riskAmountUsd = INITIAL_CAPITAL * (RISK_PCT / 100.0);
    const rawQtyBtc = slDist > 0 ? riskAmountUsd / slDist : 0;
    const maxNotional = INITIAL_CAPITAL * LEVERAGE * 0.95;
    const maxBtcAllowed = maxNotional / entryPrice;
    const cappedQty = Math.min(rawQtyBtc, maxBtcAllowed);
    return Math.floor(cappedQty * 1000) / 1000;
}

// === 4. EJECUCIÓN EN BINANCE FUTURES ===
async function executeBinanceOrder(
    direction: 'LONG' | 'SHORT',
    entryPrice: number,
    tpDist: number,
    slDist: number
): Promise<{ status: string; realEntry: number; realTp: number; realSl: number; executedQty: number }> {
    const qty = calculateSafeBtcQty(slDist, entryPrice);
    const notional = qty * entryPrice;

    if (!autoTradeActive) {
        return {
            status: 'SIMULADO_SOLO_LECTURA',
            realEntry: entryPrice,
            realTp: direction === 'LONG' ? entryPrice + tpDist : entryPrice - tpDist,
            realSl: direction === 'LONG' ? entryPrice - slDist : entryPrice + slDist,
            executedQty: qty
        };
    }

    const existingPos = await getRealBinancePosition();
    if (existingPos.amt !== 0) {
        return {
            status: `OMITIDA_POSICION_ACTIVA (${existingPos.amt} BTC)`,
            realEntry: entryPrice,
            realTp: 0,
            realSl: 0,
            executedQty: 0
        };
    }

    if (qty < 0.001 || notional < 100) {
        return {
            status: `OMITIDA_POR_MINIMO (${qty} BTC / $${notional.toFixed(2)} < $100)`,
            realEntry: entryPrice,
            realTp: 0,
            realSl: 0,
            executedQty: 0
        };
    }

    const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';

    try {
        await binanceRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol: SYMBOL }).catch(() => {});
        await binanceRequest('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: SYMBOL }).catch(() => {});

        const orderRes = await binanceRequest('/fapi/v1/order', 'POST', {
            symbol: SYMBOL,
            side: entrySide,
            type: 'MARKET',
            quantity: qty
        });

        await new Promise((resolve) => setTimeout(resolve, 1200));
        const confirmedPos = await getRealBinancePosition();
        const realEntry = confirmedPos.entryPrice > 0
            ? confirmedPos.entryPrice
            : (Number(orderRes.avgPrice) > 0 ? Number(orderRes.avgPrice) : entryPrice);

        const realTp = direction === 'LONG' ? realEntry + tpDist : realEntry - tpDist;
        const realSl = direction === 'LONG' ? realEntry - slDist : realEntry + slDist;

        const tpFormatted = realTp.toFixed(1);
        const slFormatted = realSl.toFixed(1);

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
            if (slErr.message?.includes('-2021')) {
                await binanceRequest('/fapi/v1/order', 'POST', { symbol: SYMBOL, side: exitSide, type: 'MARKET', quantity: qty });
                return { status: 'CERRADA_EMERGENCIA_SL_CRUZADO', realEntry, realTp, realSl, executedQty: qty };
            }
            throw slErr;
        }

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
                await binanceRequest('/fapi/v1/order', 'POST', { symbol: SYMBOL, side: exitSide, type: 'MARKET', quantity: qty });
                return { status: 'CERRADA_EMERGENCIA_TP_CRUZADO', realEntry, realTp, realSl, executedQty: qty };
            }
            throw tpErr;
        }

        playAlertSound('ENTRADA');
        console.log(`\n🚀 ORDEN EJECUTADA [ID: ${orderRes.orderId}] | ${entrySide} ${qty} BTC @ ${realEntry.toFixed(1)} | TP: ${tpFormatted} | SL: ${slFormatted}`);
        return {
            status: `EJECUTADA_ID_${orderRes.orderId}_QTY_${qty}_ENTRY_${realEntry.toFixed(1)}`,
            realEntry,
            realTp,
            realSl,
            executedQty: qty
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ Error enviando orden a Binance:`, errMsg);
        return { status: `ERROR_API: ${errMsg}`, realEntry: entryPrice, realTp: 0, realSl: 0, executedQty: 0 };
    }
}

// === 5. AUDITORÍA CSV ===
function initCsv() {
    if (!fs.existsSync(CSV_FILENAME)) {
        const headers = [
            'Fecha_Hora',
            'Modo_Ejecucion',
            'Evento',
            'Direccion',
            'Precio_BTC_Actual',
            'Precio_Entrada_Real',
            'Take_Profit_Real',
            'Stop_Loss_Real',
            'Cantidad_BTC',
            'Estado_Orden_Binance',
            'PNL_Bruto_USD',
            'Comisiones_Fees_USD',
            'PNL_Neto_Real_USD'
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
    cantidadBtc: number;
    estadoBinance: string;
    pnlBrutoUsd: number;
    feesUsd: number;
    pnlNetoUsd: number;
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
        row.cantidadBtc.toFixed(4),
        `"${row.estadoBinance}"`,
        row.pnlBrutoUsd.toFixed(4),
        row.feesUsd.toFixed(4),
        row.pnlNetoUsd.toFixed(4)
    ].join(',') + '\n';

    fs.appendFileSync(CSV_FILENAME, line, 'utf8');
}

// === 6. GESTOR DE ESTADO EN TIEMPO REAL (SIN ARRASTRE HISTÓRICO) ===
let activeRange: {
    high: number;
    low: number;
    createdAtMs: number;
} | null = null;

let activeRealTrade: {
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
    qty: number;
    openTimeMs: number;
} | null = null;

let prevStateKey = '';
let isRunning = false;

function formatTime(): string {
    return new Date().toLocaleTimeString('es-VE', { hour12: false });
}

async function checkMarket() {
    if (isRunning) return;
    isRunning = true;

    try {
        // 1. Si hay una operación abierta, vigilar si ya cerró en Binance
        if (activeRealTrade !== null) {
            if (autoTradeActive) {
                const livePos = await getRealBinancePosition();
                if (livePos.amt === 0) {
                    await binanceRequest('/fapi/v1/algoOpenOrders', 'DELETE', { symbol: SYMBOL }).catch(() => {});
                    const accounting = await fetchLastClosedTradeAccounting(activeRealTrade.openTimeMs);
                    const tipoCierre = accounting.grossPnl >= 0 ? 'CIERRE_TP_REAL' : 'CIERRE_SL_REAL';

                    logTradeToCsv({
                        evento: tipoCierre,
                        direccion: activeRealTrade.direction,
                        precioActual: activeRealTrade.entryPrice,
                        entrada: activeRealTrade.entryPrice,
                        tp: activeRealTrade.tpPrice,
                        sl: activeRealTrade.slPrice,
                        cantidadBtc: activeRealTrade.qty,
                        estadoBinance: 'CERRADA_EN_BINANCE',
                        pnlBrutoUsd: accounting.grossPnl,
                        feesUsd: accounting.totalFees,
                        pnlNetoUsd: accounting.netPnl
                    });

                    playAlertSound('CIERRE');
                    console.log(`\n======================================================`);
                    console.log(`[${formatTime()}] 🏁 POSICIÓN CERRADA (${tipoCierre})`);
                    console.log(`PnL Bruto: ${accounting.grossPnl >= 0 ? '+' : ''}${accounting.grossPnl.toFixed(4)} | Fees: -${accounting.totalFees.toFixed(4)} | NETO: ${accounting.netPnl >= 0 ? '+' : ''}${accounting.netPnl.toFixed(4)} USDT`);
                    console.log(`======================================================\n`);
                    activeRealTrade = null;
                    activeRange = null; // Forzar búsqueda de nuevo rango limpio
                }
            }
        }

        // 2. Obtener indicadores actuales desde PineTS
        const pineTS = new PineTS(Provider.Binance, SYMBOL, TIMEFRAME, CANDLES_LIMIT);
        const { plots } = await pineTS.run(elonIndicatorsPine);

        const getLast = (plotName: string): number => {
            const series = plots[plotName]?.data;
            if (!series || series.length === 0) return 0;
            return Number(series[series.length - 1].value) || 0;
        };

        const ema50 = getLast('EMA50');
        const boxHigh = getLast('BoxHigh');
        const boxLow = getLast('BoxLow');
        const lastClose = getLast('LastClose');
        const curHigh = getLast('CurHigh');
        const curLow = getLast('CurLow');

        if (lastClose === 0 || ema50 === 0) return;

        // 3. Si NO hay operación abierta, gestionar el rango en tiempo real
        if (activeRealTrade === null) {
            // Expirar rango si lleva más de MAX_WAIT_MINUTES sin romper
            if (activeRange !== null && (Date.now() - activeRange.createdAtMs) > MAX_WAIT_MINUTES * 60 * 1000) {
                activeRange = null;
            }

            // Capturar nuevo rango válido (>= MIN_RANGE_PCT)
            if (activeRange === null && boxHigh > boxLow) {
                const rangePct = ((boxHigh - boxLow) / lastClose) * 100.0;
                if (rangePct >= MIN_RANGE_PCT) {
                    activeRange = {
                        high: boxHigh,
                        low: boxLow,
                        createdAtMs: Date.now()
                    };
                }
            }

            // Evaluar ruptura en tiempo real alineada con EMA 50
            if (activeRange !== null) {
                const rangeUsd = activeRange.high - activeRange.low;
                const tpDist = rangeUsd * TP_MULT;
                const slDist = rangeUsd * SL_MULT;

                // Ruptura Alcista (Long) con precio por encima de EMA 50
                if (curHigh >= activeRange.high && lastClose > ema50) {
                    const execRes = await executeBinanceOrder('LONG', lastClose, tpDist, slDist);
                    if (execRes.status.startsWith('EJECUTADA_ID_') || !autoTradeActive) {
                        activeRealTrade = {
                            direction: 'LONG',
                            entryPrice: execRes.realEntry,
                            tpPrice: execRes.realTp,
                            slPrice: execRes.realSl,
                            qty: execRes.executedQty,
                            openTimeMs: Date.now()
                        };
                    }
                    logTradeToCsv({
                        evento: 'ENTRY_LONG',
                        direccion: 'LONG',
                        precioActual: lastClose,
                        entrada: execRes.realEntry,
                        tp: execRes.realTp,
                        sl: execRes.realSl,
                        cantidadBtc: execRes.executedQty,
                        estadoBinance: execRes.status,
                        pnlBrutoUsd: 0,
                        feesUsd: 0,
                        pnlNetoUsd: 0
                    });
                    activeRange = null;
                }
                // Ruptura Bajista (Short) con precio por debajo de EMA 50
                else if (curLow <= activeRange.low && lastClose < ema50) {
                    const execRes = await executeBinanceOrder('SHORT', lastClose, tpDist, slDist);
                    if (execRes.status.startsWith('EJECUTADA_ID_') || !autoTradeActive) {
                        activeRealTrade = {
                            direction: 'SHORT',
                            entryPrice: execRes.realEntry,
                            tpPrice: execRes.realTp,
                            slPrice: execRes.realSl,
                            qty: execRes.executedQty,
                            openTimeMs: Date.now()
                        };
                    }
                    logTradeToCsv({
                        evento: 'ENTRY_SHORT',
                        direccion: 'SHORT',
                        precioActual: lastClose,
                        entrada: execRes.realEntry,
                        tp: execRes.realTp,
                        sl: execRes.realSl,
                        cantidadBtc: execRes.executedQty,
                        estadoBinance: execRes.status,
                        pnlBrutoUsd: 0,
                        feesUsd: 0,
                        pnlNetoUsd: 0
                    });
                    activeRange = null;
                }
            }
        }

        // 4. Salida limpia por consola
        const tendenciaTexto = lastClose > ema50 ? 'ALCISTA (>EMA50)' : 'BAJISTA (<EMA50)';
        const estadoTexto = activeRealTrade !== null
            ? `🔒 EN POSICIÓN ${activeRealTrade.direction} @ ${activeRealTrade.entryPrice.toFixed(1)}`
            : activeRange !== null
            ? `🟡 ESPERANDO RUPTURA [${activeRange.low.toFixed(1)} - ${activeRange.high.toFixed(1)}]`
            : `⚪ BUSCANDO RANGO >= ${MIN_RANGE_PCT}%`;

        const currentStateKey = `${estadoTexto}_${lastClose > ema50}`;
        if (currentStateKey !== prevStateKey) {
            console.log(`\n======================================================`);
            console.log(`[${formatTime()}] 🔔 ${estadoTexto}`);
            console.log(`Tendencia 5m:      ${tendenciaTexto} (EMA50: ${ema50.toFixed(2)})`);
            console.log(`Precio Actual BTC: ${lastClose.toFixed(2)} USDT`);
            if (activeRange !== null) {
                const amp = activeRange.high - activeRange.low;
                console.log(`Gatillo Long:      ${activeRange.high.toFixed(2)} | Gatillo Short: ${activeRange.low.toFixed(2)} (Rango: $${amp.toFixed(2)})`);
            }
            console.log(`======================================================\n`);
            prevStateKey = currentStateKey;
        } else {
            process.stdout.write(`\r[${formatTime()}] BTC: ${lastClose.toFixed(2)} | ${tendenciaTexto} | ${estadoTexto}   `);
        }
    } catch (err) {
        console.error(`\n[${formatTime()}] Error en monitoreo:`, err instanceof Error ? err.message : err);
    } finally {
        isRunning = false;
    }
}

async function bootstrap() {
    initCsv();
    await initBinanceFutures();

    console.log('======================================================');
    console.log('   ELON BTCUSDT v3 - TIEMPO REAL (SIN ARRASTRE)');
    console.log('======================================================');
    console.log(`• Archivo Config:     ${loadedEnvPath}`);
    console.log(`• Modo Auto-Trade:    ${autoTradeActive ? 'ACTIVADO' : 'DESACTIVADO (Solo señales + CSV)'}`);
    console.log(`• Entorno Binance:    ${USE_TESTNET ? 'DEMO / TESTNET' : '⚠️ PRODUCCIÓN REAL'}`);
    console.log(`• Capital / Lev:      $${INITIAL_CAPITAL.toFixed(2)} USDT | ${LEVERAGE}x (${MARGIN_TYPE})`);
    console.log(`• Parámetros:         Rango >= ${MIN_RANGE_PCT}% | EMA 50 | TP ${TP_MULT}x / SL ${SL_MULT}x`);
    console.log('======================================================');

    checkMarket();
    setInterval(checkMarket, POLL_INTERVAL_SEC * 1000);
}

bootstrap();