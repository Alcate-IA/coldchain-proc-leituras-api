import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import winston from 'winston';
import moment from 'moment-timezone';
import * as ss from 'simple-statistics';

dotenv.config();

const TIMEZONE_CONFIG = 'America/Sao_Paulo';

// ============================================================================
// 1. CONSTANTES E TUNING
// ============================================================================

const HARDCODED_BLOCKLIST = [
    'BC:57:29:1E:2F:2C', 
];

// Limites Globais (Fallback)
const ENV_TEMP_MAX_NORMAL = Number(process.env.GLOBAL_TEMP_MAX) || -5.0; 
const ENV_TEMP_MIN_GLOBAL = Number(process.env.GLOBAL_TEMP_MIN) || -30.0;

// Modo Alto Fluxo
const ENV_TEMP_MAX_HIGH_TRAFFIC = -2.0; 
const DAYS_HIGH_TRAFFIC = [3, 4]; 

// Configurações
const DB_FLUSH_INTERVAL_MS = 10000; 
const DB_MIN_VAR_TEMP = 0.2;        
const DB_MIN_VAR_HUM = 2.0;         
const DB_HEARTBEAT_MS = 10 * 60 * 1000; 

// --- IA & PORTA VIRTUAL (ALTA SENSIBILIDADE) ---
const PREDICT_WINDOW_MINS = 30;      
const DATA_SAMPLE_INTERVAL_SEC = 10; 
const MIN_DATA_POINTS = 30;          
const PREDICT_WARN_THRESHOLD = 60;   

// *** ZONA DE TUNING FÍSICO (AJUSTADO PARA SENSIBILIDADE EXTREMA) ***
const VDOOR_RISE_THRESHOLD = 1.8;   // Delta bruto: Agora pega variação de 1.8°C (ex: -19 para -17.2)
const VDOOR_OPEN_SLOPE = 0.9;       // Slope: Reduzido de 2.0 para 0.9 (Sobe quase 1°C/min = Porta)
const FAST_CLOSE_SLOPE = -0.15;     // Fast Close: Reduzido de -0.3 para -0.15 (Fechamento mais responsivo)

const DEFROST_MIN_SLOPE = 0.25;     // Mínimo para Degelo
const DEFROST_MAX_SLOPE = 0.85;     // Máximo Degelo (Acima de 0.85 entra na zona de Porta)
const DEFROST_EXIT_SLOPE = -0.4;    // Saída de Degelo

const VDOOR_WINDOW_MINS = 5;      
const VDOOR_COOLDOWN = 20 * 60 * 1000; 

// Alerting
const BATCH_ALERT_INTERVAL_MS = 5 * 60 * 1000; 
const ALERT_SOAK_TIME_MS = 10 * 60 * 1000;      
const CALL_PERSISTENCE_MS = 30 * 60 * 1000;     
const EXTREME_DEVIATION_C = 10.0;               
const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000; 
const GATEWAY_CHECK_INTERVAL_MS = 60 * 1000; 

// ============================================================================
// 2. LOGGER
// ============================================================================
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: () => moment().tz(TIMEZONE_CONFIG).format('HH:mm:ss') }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase().padEnd(5)} | ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.Console({ format: winston.format.colorize({ all: true }) })
    ],
});

// ============================================================================
// 3. ESTADO EM MEMÓRIA
// ============================================================================
const lastReadings = new Map();   
const alertControl = new Map();   
const sensorHistory = new Map();  
const alertWatchlist = new Map(); 
const gatewayHeartbeats = new Map(); 

let configCache = new Map();      
let secondarySensorsBlocklist = new Set(); 

let dbTelemetryBuffer = [];
let dbDoorBuffer = []; 
let n8nAlertBuffer = [];

// ============================================================================
// 4. INFRAESTRUTURA
// ============================================================================
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com', {
    clientId: 'alcateia_sensitive_v4_' + Math.random().toString(16).substring(2, 8),
    clean: true,
    reconnectPeriod: 5000
});

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat';

app.use(express.json());
app.use(cors());

app.get('/health', (req, res) => {
    const now = Date.now();
    const sensorsDetail = [];
    
    configCache.forEach((config, mac) => {
        const reading = lastReadings.get(mac);
        const ctrl = alertControl.get(mac);
        const hasData = reading && reading.ts > 0;

        let statusGeral = 'OK 🟢';
        if (ctrl?.is_defrosting) statusGeral = 'DEGELO ❄️';
        else if (ctrl?.last_virtual_state) statusGeral = 'PORTA ABERTA 🔓';
        
        sensorsDetail.push({
            nome: config.display_name || mac,
            temp: hasData ? reading.db_temp : 'N/A',
            status: statusGeral,
            seen_ago: hasData ? Math.floor((now - reading.ts) / 1000) + 's' : '-'
        });
    });

    sensorsDetail.sort((a, b) => a.nome.localeCompare(b.nome));

    res.json({
        status: 'UP',
        uptime: process.uptime().toFixed(0) + 's',
        total_sensors: configCache.size,
        sensors: sensorsDetail
    });
});

// ============================================================================
// 5. CACHE E SYNC
// ============================================================================
const formatarMac = (mac) => mac?.includes(':') ? mac : mac?.replace(/(.{2})(?=.)/g, '$1:');

const calcularBateria = (mV) => {
    if (!mV) return 0;
    return Math.min(100, Math.max(0, Math.round(((mV - 2500) / (3600 - 2500)) * 100)));
};

const atualizarCacheSensores = async () => {
    try {
        const { data: configs, error } = await supabase
            .from('sensor_configs')
            .select('mac, sensor_porta_vinculado, display_name, temp_max, temp_min, hum_max, hum_min, em_manutencao'); 

        if (error) throw error;
        
        const novoCache = new Map();
        const novaBlocklist = new Set(); 

        configs.forEach(c => {
            const macFormatted = formatarMac(c.mac);
            if (macFormatted) novoCache.set(macFormatted, c);
            if (c.sensor_porta_vinculado && c.sensor_porta_vinculado.length > 5) {
                novaBlocklist.add(formatarMac(c.sensor_porta_vinculado));
            }
        });
        
        configCache = novoCache;
        secondarySensorsBlocklist = novaBlocklist;
        if (process.env.LOG_LEVEL === 'debug') logger.info(`🔄 [CACHE] ${configCache.size} sensores.`);
    } catch (e) { logger.error(`❌ [CACHE] Erro: ${e.message}`); }
};

const sincronizarGatewaysConhecidos = async () => {
    try {
        const ontem = moment().subtract(24, 'hours').toISOString();
        const { data, error } = await supabase
            .from('telemetry_logs')
            .select('gw, ts').gte('ts', ontem).order('ts', { ascending: false }).limit(2000); 
        if (error) throw error;
        data.forEach(log => {
            const gwMac = formatarMac(log.gw);
            if (gwMac && !gatewayHeartbeats.has(gwMac)) {
                gatewayHeartbeats.set(gwMac, { last_seen: new Date(log.ts).getTime(), source: 'DB' });
            }
        });
    } catch (e) { logger.error(`❌ [GW SYNC] Erro: ${e.message}`); }
};

setTimeout(() => { atualizarCacheSensores(); sincronizarGatewaysConhecidos(); }, 1000);
setInterval(atualizarCacheSensores, 10 * 60 * 1000);
setInterval(sincronizarGatewaysConhecidos, 30 * 60 * 1000);

// ============================================================================
// 6. INTELIGÊNCIA TÉRMICA (COM FAST SLOPE)
// ============================================================================
const analisarTendencia = (mac, tempAtual, tempMax) => {
    const now = Date.now();
    let history = sensorHistory.get(mac) || [];
    const lastEntry = history[history.length - 1];
    
    if (!lastEntry || (now - lastEntry.ts >= DATA_SAMPLE_INTERVAL_SEC * 1000)) {
        history.push({ ts: now, temp: tempAtual });
        const windowStart = now - (PREDICT_WINDOW_MINS * 60 * 1000);
        history = history.filter(h => h.ts > windowStart);
        sensorHistory.set(mac, history);
    }

    if (history.length < MIN_DATA_POINTS) return { ready: false, count: history.length };

    // 1. Slope Padrão (30 min window)
    const startTime = history[0].ts;
    const dataPoints = history.map(h => [ (h.ts - startTime) / 60000, h.temp ]);
    const { m, b } = ss.linearRegression(dataPoints);

    // 2. Fast Slope (Últimos 5 pontos)
    let fastSlope = m; 
    const FAST_WINDOW = 5;
    if (history.length >= FAST_WINDOW) {
        const recentHistory = history.slice(-FAST_WINDOW);
        const startFast = recentHistory[0].ts;
        const fastPoints = recentHistory.map(h => [ (h.ts - startFast) / 60000, h.temp ]);
        const fastRegression = ss.linearRegression(fastPoints);
        fastSlope = fastRegression.m;
    }

    const soma = history.reduce((acc, item) => acc + item.temp, 0);
    const media = Number((soma / history.length).toFixed(2));

    let previsaoDetalhada = null;
    if (tempMax !== null && m > 0.1) {
        const minutosFuturos = (tempMax - b) / m;
        const minutosPassados = (now - startTime) / 60000;
        const minutosRestantes = minutosFuturos - minutosPassados;
        if (minutosRestantes > 0 && minutosRestantes < PREDICT_WARN_THRESHOLD) {
            previsaoDetalhada = { tempo_restante: Math.floor(minutosRestantes), velocidade: Number(m.toFixed(2)) };
        }
    }
    
    return { ready: true, slope: m, fast_slope: fastSlope, avg: media, previsao: previsaoDetalhada };
};

const analisarPortaVirtual = (mac, tempAtual) => {
    let history = sensorHistory.get(mac) || [];
    if (history.length < 3) return null;
    const now = Date.now();
    const windowStart = now - (VDOOR_WINDOW_MINS * 60 * 1000);
    const pastReading = history.find(h => h.ts >= windowStart);
    if (!pastReading) return null;
    
    // Comparação de Delta absoluto
    const deltaTemp = tempAtual - pastReading.temp;
    
    // Usa o novo limiar mais sensível (1.8°C)
    if (deltaTemp >= VDOOR_RISE_THRESHOLD) {
        return { detectado: true, delta: deltaTemp.toFixed(1) };
    }
    return null;
};

// ============================================================================
// 7. ANÁLISE DE ALERTAS (TUNING SENSÍVEL)
// ============================================================================
const verificarSensor = (sensorMac, leitura, gatewayMac) => {
    const config = configCache.get(sensorMac);
    const nome = config.display_name || sensorMac;
    const now = Date.now();
    
    if (config.em_manutencao) {
        if (alertWatchlist.has(sensorMac)) alertWatchlist.delete(sensorMac);
        if (alertControl.has(sensorMac)) alertControl.delete(sensorMac);
        return null;
    }

    const ctrl = alertControl.get(sensorMac) || {};
    const lastState = ctrl.last_virtual_state === true;
    let isDefrosting = ctrl.is_defrosting === true; 

    // Limites
    const diaHoje = moment(now).tz(TIMEZONE_CONFIG).day();
    const isAltoFluxo = DAYS_HIGH_TRAFFIC.includes(diaHoje);
    const LIMIT_TEMP_MAX = config.temp_max !== null ? config.temp_max : (isAltoFluxo ? ENV_TEMP_MAX_HIGH_TRAFFIC : ENV_TEMP_MAX_NORMAL);
    const LIMIT_TEMP_MIN = config.temp_min !== null ? config.temp_min : ENV_TEMP_MIN_GLOBAL;
    const LIMIT_HUM_MAX = config.hum_max;
    const LIMIT_HUM_MIN = config.hum_min;

    let mensagemProblema = null;
    let prioridade = 'ALTA';
    let dadosPrevisao = null;
    let desvioExtremo = false;

    if (leitura.temp !== undefined) {
        const val = Number(leitura.temp);
        const iaStats = analisarTendencia(sensorMac, val, LIMIT_TEMP_MAX);

        if (iaStats.ready) {
            // --- DETECÇÃO DE DEGELO (SEPARAÇÃO DO RUÍDO) ---
            if (!isDefrosting && !lastState) {
                // Slope moderado (0.25 a 0.85) é degelo. Acima de 0.9 é porta.
                if (iaStats.slope >= DEFROST_MIN_SLOPE && iaStats.slope <= DEFROST_MAX_SLOPE) {
                    if (val > (iaStats.avg + 0.5)) isDefrosting = true;
                }
            }
            if (isDefrosting) {
                if (iaStats.slope < DEFROST_EXIT_SLOPE) isDefrosting = false;
            }
            ctrl.is_defrosting = isDefrosting;

            // =================================================================
            // LÓGICA DE PORTA VIRTUAL
            // =================================================================
            let currentState = lastState;
            
            if (!isDefrosting) { 
                if (lastState === true) {
                    // FECHAMENTO: Se o slope cair levemente (-0.05) OU cair rápido (-0.15), fecha.
                    if (iaStats.slope < -0.05 || iaStats.fast_slope < FAST_CLOSE_SLOPE) {
                        currentState = false; 
                    }
                } else {
                    // ABERTURA: Verifica Delta (> 1.8°C) OU Slope Rápido (> 0.9)
                    const vDoor = analisarPortaVirtual(sensorMac, val);
                    if ((vDoor && vDoor.detectado) || iaStats.slope > VDOOR_OPEN_SLOPE) {
                        currentState = true;
                    }
                }
            } else {
                currentState = false; // Degelo não é porta aberta
            }

            if (currentState !== ctrl.last_virtual_state) {
                const acao = currentState ? 'ABRIU 🔓' : 'FECHOU 🔒';
                logger.info(`🔄 [ESTADO] ${nome}: ${acao} (Slope: ${iaStats.slope.toFixed(2)} | Fast: ${iaStats.fast_slope.toFixed(2)})`);
                dbDoorBuffer.push({
                    gateway_mac: gatewayMac || "GW-UNKNOWN",
                    sensor_mac: sensorMac, 
                    timestamp_read: new Date().toISOString(),
                    is_open: currentState,
                    alarm_code: currentState ? 1 : 0,
                    battery_percent: calcularBateria(leitura.vbatt),
                    rssi: leitura.rssi 
                });
            } else {
                let icon = currentState ? '🔓' : '🔒';
                if (isDefrosting) icon = '❄️'; 
                logger.info(`🔍 [ANÁLISE] ${nome.padEnd(20)} | Atual: ${val}°C | Média: ${iaStats.avg}°C | Status: ${icon} (S: ${iaStats.slope.toFixed(2)} / F: ${iaStats.fast_slope.toFixed(2)})`);
            }
            
            ctrl.last_virtual_state = currentState;
            alertControl.set(sensorMac, ctrl);

            // --- ALERTAS DE TEMPERATURA ---
            const tolerance = isDefrosting ? 15.0 : 0.0;

            if (val < LIMIT_TEMP_MIN) {
                mensagemProblema = `Temp BAIXA: ${val}°C (Min: ${LIMIT_TEMP_MIN}°C)`;
                if (val < (LIMIT_TEMP_MIN - EXTREME_DEVIATION_C)) desvioExtremo = true;
            } 
            else if (val > (LIMIT_TEMP_MAX + tolerance)) {
                mensagemProblema = `Temp ALTA: ${val}°C (Max: ${LIMIT_TEMP_MAX}°C)`;
                if (val > (LIMIT_TEMP_MAX + EXTREME_DEVIATION_C)) desvioExtremo = true;
            } 
            else if (iaStats.previsao && !isDefrosting) {
                mensagemProblema = `TENDÊNCIA: Atingirá limite em ${iaStats.previsao.tempo_restante}min`;
                prioridade = 'PREDITIVA';
                dadosPrevisao = { ...iaStats.previsao };
            }

        } else {
            logger.info(`⏳ [CALIBRANDO] ${nome.padEnd(20)} | ${iaStats.count}/${MIN_DATA_POINTS}`);
        }
    }

    if (!mensagemProblema && leitura.humidity !== undefined) {
        const valHum = Number(leitura.humidity);
        if (LIMIT_HUM_MAX && valHum > LIMIT_HUM_MAX) mensagemProblema = `Umid ALTA: ${valHum}%`;
        else if (LIMIT_HUM_MIN && valHum < LIMIT_HUM_MIN) mensagemProblema = `Umid BAIXA: ${valHum}%`;
    }

    if (!mensagemProblema) {
        if (alertWatchlist.has(sensorMac)) {
            logger.info(`💚 [NORMALIZOU] ${nome} voltou para o range.`);
            alertWatchlist.delete(sensorMac);
        }
        return null;
    }

    const entry = alertWatchlist.get(sensorMac);
    if (!entry) {
        alertWatchlist.set(sensorMac, { first_seen: now, msg: mensagemProblema });
        logger.info(`👀 [WATCHLIST] ${nome} fora do range. Observando...`);
        return null;
    } else {
        const tempoDecorrido = now - entry.first_seen;
        if (tempoDecorrido < ALERT_SOAK_TIME_MS) return null;
        
        const iaStats = sensorHistory.get(sensorMac) ? analisarTendencia(sensorMac, Number(leitura.temp || 0), LIMIT_TEMP_MAX) : { slope: 0 };
        const isGradual = Math.abs(iaStats.slope) < 1.0; 

        if (tempoDecorrido > CALL_PERSISTENCE_MS && desvioExtremo && isGradual) {
            prioridade = 'CRITICA'; 
        } else {
            prioridade = 'ALTA';    
        }

        const lastSent = ctrl.last_alert_sent_ts || 0;
        const cooldownEnvio = prioridade === 'PREDITIVA' ? 45*60000 : 15*60000;

        if (now - lastSent > cooldownEnvio) {
            ctrl.last_alert_sent_ts = now;
            alertControl.set(sensorMac, ctrl);
            return {
                sensor_nome: nome,
                sensor_mac: sensorMac,
                prioridade: prioridade,
                mensagens: [mensagemProblema],
                timestamp_iso: moment(now).tz(TIMEZONE_CONFIG).format(),
                dados_contexto: {
                    temp_atual: leitura.temp,
                    previsao: dadosPrevisao,
                    limites: { max: LIMIT_TEMP_MAX, min: LIMIT_TEMP_MIN },
                    status_operacional: isDefrosting ? "EM_DEGELO" : "NORMAL"
                }
            };
        }
    }
    return null;
};

// ============================================================================
// 8. TAREFAS DE FUNDO
// ============================================================================

setInterval(async () => {
    if (dbTelemetryBuffer.length > 0) {
        const batch = [...dbTelemetryBuffer];
        dbTelemetryBuffer = [];
        await supabase.from('telemetry_logs').insert(batch);
        logger.info(`💾 [DB] Salvos ${batch.length} logs de telemetria.`);
    }
    if (dbDoorBuffer.length > 0) {
        const batch = [...dbDoorBuffer];
        dbDoorBuffer = [];
        await supabase.from('door_logs').insert(batch);
        logger.info(`💾 [DB] Salvos ${batch.length} logs de porta virtual.`);
    }
}, DB_FLUSH_INTERVAL_MS);

setInterval(async () => {
    if (n8nAlertBuffer.length === 0) return;
    logger.info(`📦 [N8N] Enviando ${n8nAlertBuffer.length} alertas acumulados...`);
    const payload = [...n8nAlertBuffer];
    n8nAlertBuffer = [];
    try {
        await fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timestamp: new Date().toISOString(), total_alertas: payload.length, is_batched: true, alertas: payload })
        });
        logger.info(`✅ [N8N] Sucesso.`);
    } catch (e) { logger.error(`❌ [N8N] Falha: ${e.message}`); }
}, BATCH_ALERT_INTERVAL_MS);

setInterval(() => {
    const now = Date.now();
    gatewayHeartbeats.forEach((data, gmac) => {
        const lastAlert = alertControl.get(gmac)?.last_alert_ts || 0;
        if (now - lastAlert < 60 * 60 * 1000) return; 
        if (now - data.last_seen > GATEWAY_TIMEOUT_MS) {
            if (HARDCODED_BLOCKLIST.includes(gmac)) return;
            const minOffline = Math.floor((now - data.last_seen) / 60000);
            n8nAlertBuffer.push({
                sensor_nome: `GATEWAY ${gmac.slice(-5)}`,
                sensor_mac: gmac,
                prioridade: 'SISTEMA',
                mensagens: [`GATEWAY OFFLINE há ${minOffline} minutos.`],
                timestamp_iso: moment(now).tz(TIMEZONE_CONFIG).format(),
                dados_contexto: { tipo: "INFRAESTRUTURA" }
            });
            logger.warn(`🔌 [GATEWAY DOWN] ${gmac} offline.`);
            const currentCtrl = alertControl.get(gmac) || {};
            currentCtrl.last_alert_ts = now;
            alertControl.set(gmac, currentCtrl);
        }
    });
}, GATEWAY_CHECK_INTERVAL_MS);

setInterval(() => {
    const now = Date.now();
    const umDia = 24 * 60 * 60 * 1000;
    for (const [mac, data] of lastReadings) {
        if ((now - data.ts) > umDia) {
            lastReadings.delete(mac);
            sensorHistory.delete(mac);
            alertControl.delete(mac);
        }
    }
    for (const [gmac, data] of gatewayHeartbeats) {
        if ((now - data.last_seen) > (umDia * 2)) gatewayHeartbeats.delete(gmac);
    }
}, 24 * 60 * 60 * 1000);

// ============================================================================
// 9. LOOP MQTT
// ============================================================================
client.on('connect', () => {
    logger.info(`✅ [MQTT] Conectado!`);
    client.subscribe(TOPIC_DATA);
    atualizarCacheSensores(); 
    sincronizarGatewaysConhecidos();
});

client.on('message', (topic, message) => {
    if (topic !== TOPIC_DATA) return;
    try {
        const payload = JSON.parse(message.toString());
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();
        items.forEach(item => {
            const gatewayMac = formatarMac(item.gmac);
            if (HARDCODED_BLOCKLIST.includes(gatewayMac)) return; 
            if (gatewayMac) gatewayHeartbeats.set(gatewayMac, { last_seen: now });
            if (!item.obj) return;
            item.obj.forEach(sensor => {
                const mac = formatarMac(sensor.dmac);
                if (HARDCODED_BLOCKLIST.includes(mac)) return;
                if (secondarySensorsBlocklist.has(mac)) return; 
                const config = configCache.get(mac);
                if (!config) return; 
                
                let last = lastReadings.get(mac) || { ts: 0, db_temp: -999, db_hum: -999, db_ts: 0 };
                const alerta = verificarSensor(mac, sensor, gatewayMac);
                if (alerta) {
                    n8nAlertBuffer.push(alerta);
                    logger.warn(`⚠️ [ALERTA] ${config.display_name}: ${alerta.mensagens[0]}`);
                }
                if (sensor.temp !== undefined) {
                    const diffTemp = Math.abs(sensor.temp - last.db_temp);
                    const diffHum = Math.abs((sensor.humidity || 0) - last.db_hum);
                    if (diffTemp >= DB_MIN_VAR_TEMP || diffHum >= DB_MIN_VAR_HUM || (now - last.db_ts > DB_HEARTBEAT_MS)) {
                        dbTelemetryBuffer.push({ gw: item.gmac, mac: mac, ts: new Date().toISOString(), temp: sensor.temp, hum: sensor.humidity, batt: calcularBateria(sensor.vbatt), rssi: sensor.rssi });
                        last.db_temp = sensor.temp;
                        last.db_hum = sensor.humidity;
                        last.db_ts = now;
                    }
                }
                last.ts = now;
                lastReadings.set(mac, last);
            });
        });
    } catch (e) { logger.error(`🔥 Loop Error: ${e.message}`); }
});

const shutdown = async () => {
    logger.info('🛑 Encerrando sistema...');
    client.end(); 
    if (dbTelemetryBuffer.length > 0) await supabase.from('telemetry_logs').insert(dbTelemetryBuffer);
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => logger.info(`🚀 Monitor ColdChain Térmico Online na porta ${PORT}`));