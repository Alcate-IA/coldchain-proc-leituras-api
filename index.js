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
// 1. CONSTANTES E TUNING (NORMAL vs ULTRA)
// ============================================================================

const HARDCODED_BLOCKLIST = [
    'BC:57:29:1E:2F:2C', 
];

// Limites Globais (Fallback)
const ENV_TEMP_MAX_NORMAL = Number(process.env.GLOBAL_TEMP_MAX) || -5.0; 
const ENV_TEMP_MIN_GLOBAL = Number(process.env.GLOBAL_TEMP_MIN) || -30.0;
const ENV_TEMP_MAX_HIGH_TRAFFIC = -2.0; 
const DAYS_HIGH_TRAFFIC = [3, 4]; 

// Configurações de Banco e Rede
const DB_FLUSH_INTERVAL_MS = 10000; 
const DB_MIN_VAR_TEMP = 0.2;        
const DB_MIN_VAR_HUM = 2.0;         
const DB_HEARTBEAT_MS = 10 * 60 * 1000; 

// --- IA & INTEGRIDADE DE DADOS ---
const PREDICT_WINDOW_MINS = 20;      // Janela de análise deslizante
const MIN_DATA_POINTS = 10;          // Mínimo de pontos para regressão confiável
const DATA_SAMPLE_INTERVAL_SEC = 10; // Intervalo mínimo entre amostras
const DEFROST_CYCLE_MIN_DURATION_MS = 5 * 60 * 1000; // Degelo mínimo de 5min
const DEFROST_CYCLE_MAX_DURATION_MS = 60 * 60 * 1000; // Degelo máximo de 60min

// *** TUNING FÍSICO: REFRIGERAÇÃO NORMAL (0°C a -10°C) ***
const TUNING_NORMAL = {
    DOOR_ACCEL: 0.3,       // Aceleração súbita (Porta)
    DOOR_SLOPE: 0.9,       // Velocidade de subida bruta
    STD_ERROR_DOOR: 0.45,  // Turbulência alta (Ar externo misturando)
    DEFROST_MAX_SLOPE: 0.8,
    DEFROST_MIN_R2: 0.85,  // Degelo é linear, R² alto
    DEFROST_MIN_SLOPE: 0.15, // Slope mínimo para iniciar degelo
    DEFROST_VARIANCE_THRESHOLD: 0.5, // Variância máxima durante degelo
    DOOR_VARIANCE_THRESHOLD: 1.2,    // Variância alta indica porta
    EMA_ALPHA: 0.3         // Filtro de média móvel exponencial
};

// *** TUNING FÍSICO: ULTRACONGELADORES (< -15°C) ***
const TUNING_ULTRA = {
    DOOR_ACCEL: 0.6,       // Ar denso troca mais rápido
    DOOR_SLOPE: 1.5,       // Subida violenta
    STD_ERROR_DOOR: 0.65,  // Muita turbulência térmica
    DEFROST_MAX_SLOPE: 4.0,// Resistência aquece rápido
    DEFROST_MIN_R2: 0.90,  // Degelo controlado é muito estável
    DEFROST_MIN_SLOPE: 0.25, // Slope mínimo mais alto para ultracongeladores
    DEFROST_VARIANCE_THRESHOLD: 0.8, // Variância maior permitida
    DOOR_VARIANCE_THRESHOLD: 1.5,    // Variância ainda maior para porta
    EMA_ALPHA: 0.25        // Filtro mais suave para ultracongeladores
};

// Alerting & Infra
const BATCH_ALERT_INTERVAL_MS = 5 * 60 * 1000; 
const ALERT_SOAK_TIME_MS = 10 * 60 * 1000;      
const CALL_PERSISTENCE_MS = 30 * 60 * 1000;     
const EXTREME_DEVIATION_C = 10.0;               
const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000; 
const GATEWAY_CHECK_INTERVAL_MS = 60 * 1000; 

// ============================================================================
// 2. LOGGER (MELHORADO COM LOGS DETALHADOS)
// ============================================================================
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug', // Default para debug para ver tudo
    format: winston.format.combine(
        winston.format.timestamp({ format: () => moment().tz(TIMEZONE_CONFIG).format('HH:mm:ss') }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase().padEnd(5)} | ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log', level: 'debug' }), // Log completo em arquivo
        new winston.transports.Console({ format: winston.format.colorize({ all: true }) })
    ],
});

// Helper para logs estruturados
const logDebug = (categoria, mensagem, dados = {}) => {
    const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
    logger.debug(`[${categoria}] ${mensagem}${dadosStr}`);
};

const logInfo = (categoria, mensagem, dados = {}) => {
    const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
    logger.info(`[${categoria}] ${mensagem}${dadosStr}`);
};

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
    clientId: 'alcateia_neural_v5_' + Math.random().toString(16).substring(2, 8),
    clean: true,
    reconnectPeriod: 5000
});

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat';

app.use(express.json());
app.use(cors());

app.get('/health', (req, res) => {
    const now = Date.now();
    const sensorsDetail = [];
    
    logDebug('HEALTH', 'Health check acessado');
    
    configCache.forEach((config, mac) => {
        const reading = lastReadings.get(mac);
        const ctrl = alertControl.get(mac);
        const hasData = reading && reading.ts > 0;
        const history = sensorHistory.get(mac);
        
        let statusGeral = 'OK 🟢';
        if (ctrl?.is_defrosting) statusGeral = 'DEGELO ❄️';
        else if (ctrl?.last_virtual_state) statusGeral = 'PORTA ABERTA 🔓';
        
        // Dados de predição e análise
        let predicao = '-';
        let defrostInfo = null;
        if (history && history.length > MIN_DATA_POINTS) {
            const isUltra = (config.temp_min && config.temp_min < -15);
            const stats = analisarTendencia(mac, reading.db_temp, isUltra);
            if (stats.ready) {
                predicao = `Slope: ${stats.slope.toFixed(2)} | R²: ${stats.r2.toFixed(2)} | Var: ${stats.variance.toFixed(2)}`;
                if (stats.cicloDegelo) {
                    predicao += ` | Fase: ${stats.cicloDegelo.phase}`;
                }
            }
        }
        
        // Informações de degelo
        if (ctrl?.is_defrosting) {
            const defrostStart = ctrl.defrost_start_ts || 0;
            const duration = defrostStart > 0 ? Math.floor((now - defrostStart) / 60000) : 0;
            defrostInfo = {
                duracao_min: duration,
                temp_inicio: ctrl.defrost_start_temp || null,
                temp_pico: ctrl.defrost_peak_temp || null
            };
        }

        sensorsDetail.push({
            nome: config.display_name || mac,
            temp: hasData ? reading.db_temp : 'N/A',
            status: statusGeral,
            ia_metrics: predicao,
            defrost_info: defrostInfo,
            seen_ago: hasData ? Math.floor((now - reading.ts) / 1000) + 's' : '-'
        });
    });

    sensorsDetail.sort((a, b) => a.nome.localeCompare(b.nome));

    const response = {
        status: 'UP',
        uptime: process.uptime().toFixed(0) + 's',
        total_sensors: configCache.size,
        sensors: sensorsDetail,
        stats: {
            gateways_ativos: gatewayHeartbeats.size,
            sensores_com_dados: Array.from(lastReadings.values()).filter(r => r.ts > 0).length,
            sensores_em_degelo: Array.from(alertControl.values()).filter(c => c.is_defrosting).length,
            sensores_porta_aberta: Array.from(alertControl.values()).filter(c => c.last_virtual_state).length,
            watchlist_size: alertWatchlist.size,
            buffer_telemetry: dbTelemetryBuffer.length,
            buffer_door: dbDoorBuffer.length,
            buffer_alertas: n8nAlertBuffer.length
        }
    };
    
    logDebug('HEALTH', 'Health check respondido', {
        total_sensors: response.total_sensors,
        gateways: response.stats.gateways_ativos,
        sensores_com_dados: response.stats.sensores_com_dados
    });

    res.json(response);
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
        logDebug('CACHE', 'Iniciando atualização de cache de sensores...');
        const { data: configs, error } = await supabase
            .from('sensor_configs')
            .select('mac, sensor_porta_vinculado, display_name, temp_max, temp_min, hum_max, hum_min, em_manutencao'); 

        if (error) throw error;
        
        const novoCache = new Map();
        const novaBlocklist = new Set(); 
        let ultracongeladores = 0;
        let emManutencao = 0;

        configs.forEach(c => {
            const macFormatted = formatarMac(c.mac);
            if (macFormatted) {
                novoCache.set(macFormatted, c);
                if (c.temp_min && c.temp_min < -15) ultracongeladores++;
                if (c.em_manutencao) emManutencao++;
            }
            if (c.sensor_porta_vinculado && c.sensor_porta_vinculado.length > 5) {
                novaBlocklist.add(formatarMac(c.sensor_porta_vinculado));
            }
        });
        
        const removidos = configCache.size - novoCache.size;
        configCache = novoCache;
        secondarySensorsBlocklist = novaBlocklist;
        
        logInfo('CACHE', `Cache atualizado: ${configCache.size} sensores ativos`, {
            total: configCache.size,
            ultracongeladores,
            em_manutencao: emManutencao,
            sensores_secundarios: novaBlocklist.size,
            removidos: removidos > 0 ? removidos : 0
        });
    } catch (e) { 
        logger.error(`❌ [CACHE] Erro ao atualizar cache: ${e.message}`, { stack: e.stack });
    }
};

const sincronizarGatewaysConhecidos = async () => {
    try {
        logDebug('GW_SYNC', 'Sincronizando gateways conhecidos do banco...');
        const ontem = moment().subtract(24, 'hours').toISOString();
        const { data, error } = await supabase
            .from('telemetry_logs')
            .select('gw, ts').gte('ts', ontem).order('ts', { ascending: false }).limit(2000); 
        if (error) throw error;
        
        let novos = 0;
        data.forEach(log => {
            const gwMac = formatarMac(log.gw);
            if (gwMac && !gatewayHeartbeats.has(gwMac)) {
                gatewayHeartbeats.set(gwMac, { last_seen: new Date(log.ts).getTime(), source: 'DB' });
                novos++;
            }
        });
        
        logInfo('GW_SYNC', `Gateways sincronizados: ${gatewayHeartbeats.size} total`, {
            novos_adicionados: novos,
            total_gateways: gatewayHeartbeats.size
        });
    } catch (e) { 
        logger.error(`❌ [GW_SYNC] Erro ao sincronizar gateways: ${e.message}`, { stack: e.stack });
    }
};

/**
 * Carrega o último estado de cada porta do banco de dados
 * Isso evita falsos positivos ao reiniciar a API (não detecta abertura se já estava aberta)
 */
const carregarUltimoEstadoPortas = async () => {
    try {
        logDebug('PORTA_SYNC', 'Carregando último estado das portas do banco...');
        
        // Busca o último estado de cada sensor nas últimas 24 horas
        const ontem = moment().subtract(24, 'hours').toISOString();
        const { data, error } = await supabase
            .from('door_logs')
            .select('sensor_mac, is_open, timestamp_read')
            .gte('timestamp_read', ontem)
            .order('timestamp_read', { ascending: false });
        
        if (error) throw error;
        
        if (!data || data.length === 0) {
            logInfo('PORTA_SYNC', 'Nenhum estado de porta encontrado no banco');
            return;
        }
        
        // Agrupa por sensor_mac e pega o mais recente de cada um
        const ultimoEstadoPorSensor = new Map();
        data.forEach(log => {
            const mac = formatarMac(log.sensor_mac);
            if (mac && !ultimoEstadoPorSensor.has(mac)) {
                ultimoEstadoPorSensor.set(mac, {
                    is_open: log.is_open,
                    timestamp: log.timestamp_read
                });
            }
        });
        
        // Atualiza o alertControl com os estados carregados
        let portasCarregadas = 0;
        let portasAbertas = 0;
        let portasFechadas = 0;
        
        ultimoEstadoPorSensor.forEach((estado, mac) => {
            // Só carrega se o sensor existe no cache
            if (configCache.has(mac)) {
                const ctrl = alertControl.get(mac) || { 
                    last_virtual_state: false, 
                    is_defrosting: false 
                };
                
                // Atualiza o estado da porta com o último estado conhecido
                ctrl.last_virtual_state = estado.is_open;
                ctrl.last_porta_state_loaded_ts = new Date(estado.timestamp).getTime();
                alertControl.set(mac, ctrl);
                
                portasCarregadas++;
                if (estado.is_open) {
                    portasAbertas++;
                } else {
                    portasFechadas++;
                }
            }
        });
        
        logInfo('PORTA_SYNC', `Estados de porta carregados: ${portasCarregadas} sensores`, {
            total_carregados: portasCarregadas,
            portas_abertas: portasAbertas,
            portas_fechadas: portasFechadas,
            estados_encontrados: ultimoEstadoPorSensor.size,
            sensores_no_cache: configCache.size
        });
        
    } catch (e) {
        logger.error(`❌ [PORTA_SYNC] Erro ao carregar estados de porta: ${e.message}`, { 
            stack: e.stack 
        });
    }
};

// Inicialização: Carrega cache de sensores primeiro, depois estados de porta e gateways
setTimeout(async () => { 
    await atualizarCacheSensores(); 
    await carregarUltimoEstadoPortas(); // Deve ser chamado após cache de sensores
    sincronizarGatewaysConhecidos(); 
}, 1000);

setInterval(atualizarCacheSensores, 10 * 60 * 1000);
setInterval(sincronizarGatewaysConhecidos, 30 * 60 * 1000);

// ============================================================================
// 6. INTELIGÊNCIA TÉRMICA AVANÇADA (R², ACELERAÇÃO, VARIÂNCIA, CICLO DE DEGELO)
// ============================================================================

/**
 * Calcula média móvel exponencial (EMA) para suavizar ruído
 */
const calcularEMA = (history, alpha) => {
    if (history.length === 0) return null;
    let ema = history[0].temp;
    for (let i = 1; i < history.length; i++) {
        ema = alpha * history[i].temp + (1 - alpha) * ema;
    }
    return ema;
};

/**
 * Detecta mudança de ponto (change point) usando análise de variância
 * Retorna índice onde há mudança significativa no padrão
 */
const detectarMudancaPonto = (history) => {
    if (history.length < 6) return null;
    
    let minVariance = Infinity;
    let bestSplit = null;
    
    // Testa diferentes pontos de divisão
    for (let i = 3; i < history.length - 3; i++) {
        const part1 = history.slice(0, i).map(h => h.temp);
        const part2 = history.slice(i).map(h => h.temp);
        
        const var1 = ss.variance(part1);
        const var2 = ss.variance(part2);
        const totalVar = var1 + var2;
        
        if (totalVar < minVariance) {
            minVariance = totalVar;
            bestSplit = i;
        }
    }
    
    return bestSplit;
};

/**
 * Analisa padrão de ciclo de degelo completo (subida, pico, descida)
 */
const analisarCicloDegelo = (history, isUltra) => {
    if (history.length < 8) return null;
    
    const temps = history.map(h => h.temp);
    const maxTemp = Math.max(...temps);
    const minTemp = Math.min(...temps);
    const maxIndex = temps.indexOf(maxTemp);
    const minIndex = temps.indexOf(minTemp);
    
    // Detecta se há padrão de subida seguido de descida (ciclo de degelo)
    const isRisingPhase = maxIndex > minIndex && maxIndex > history.length * 0.3;
    const isFallingPhase = maxIndex < history.length - 3;
    
    // Calcula slopes das fases
    let risingSlope = 0;
    let fallingSlope = 0;
    
    if (isRisingPhase && maxIndex > 2) {
        const risingData = history.slice(0, maxIndex + 1).map(h => [(h.ts - history[0].ts) / 60000, h.temp]);
        if (risingData.length > 2) {
            risingSlope = ss.linearRegression(risingData).m;
        }
    }
    
    if (isFallingPhase && maxIndex < history.length - 2) {
        const fallingData = history.slice(maxIndex).map(h => [(h.ts - history[maxIndex].ts) / 60000, h.temp]);
        if (fallingData.length > 2) {
            fallingSlope = ss.linearRegression(fallingData).m;
        }
    }
    
    // Degelo típico: subida positiva seguida de descida negativa
    const isDefrostPattern = risingSlope > (isUltra ? 0.2 : 0.15) && fallingSlope < -0.1;
    const tempRise = maxTemp - minTemp;
    
    return {
        isDefrostPattern,
        risingSlope,
        fallingSlope,
        tempRise,
        maxTemp,
        minTemp,
        maxIndex,
        phase: isRisingPhase && !isFallingPhase ? 'RISING' : 
               isFallingPhase && !isRisingPhase ? 'FALLING' : 
               isRisingPhase && isFallingPhase ? 'PEAK' : 'UNKNOWN'
    };
};

const analisarTendencia = (mac, tempAtual, isUltra = false) => {
    const now = Date.now();
    let history = sensorHistory.get(mac) || [];
    const TUNING = isUltra ? TUNING_ULTRA : TUNING_NORMAL;
    
    // Controle de amostragem (Evitar dados duplicados no mesmo segundo)
    const lastSample = history.length > 0 ? history[history.length - 1] : null;
    const timeSinceLastSample = lastSample ? (now - lastSample.ts) : Infinity;
    
    if (history.length === 0 || (timeSinceLastSample >= DATA_SAMPLE_INTERVAL_SEC * 1000)) {
        history.push({ ts: now, temp: tempAtual });
        // Janela deslizante de tempo
        const windowStart = now - (PREDICT_WINDOW_MINS * 60 * 1000);
        const beforeFilter = history.length;
        history = history.filter(h => h.ts > windowStart);
        const removed = beforeFilter - history.length;
        
        if (removed > 0) {
            logDebug('ANALISE', `Janela deslizante: ${removed} pontos antigos removidos`, { mac, pontos_atuais: history.length });
        }
        
        sensorHistory.set(mac, history);
    } else {
        logDebug('ANALISE', 'Amostra ignorada (muito recente)', { 
            mac, 
            intervalo_seg: Math.floor(timeSinceLastSample / 1000),
            temp: tempAtual 
        });
    }

    if (history.length < MIN_DATA_POINTS) {
        logDebug('ANALISE', 'Dados insuficientes para análise', { 
            mac, 
            pontos: history.length, 
            minimo: MIN_DATA_POINTS,
            temp_atual: tempAtual 
        });
        return { ready: false, count: history.length };
    }

    const startTime = history[0].ts;
    // Normalizar tempo para minutos (X) e Temperatura (Y)
    const dataPoints = history.map(h => [(h.ts - startTime) / 60000, h.temp]);

    // 1. Regressão Linear Simples
    const line = ss.linearRegression(dataPoints); // retorna m (slope) e b (intercept)
    const regressionLine = ss.linearRegressionLine(line);

    // 2. R² (Coeficiente de Determinação) - Confiança da Tendência
    const r2 = ss.sampleCorrelation(dataPoints.map(p => p[0]), dataPoints.map(p => p[1])) ** 2;

    // 3. Erro Padrão da Estimativa (Standard Error) - Mede Turbulência
    const residuals = dataPoints.map(p => Math.pow(p[1] - regressionLine(p[0]), 2));
    const stdError = Math.sqrt(ss.mean(residuals));

    // 4. Variância - Mede dispersão dos dados (porta aberta = alta variância)
    const temps = history.map(h => h.temp);
    const variance = ss.variance(temps);
    const stdDev = Math.sqrt(variance);

    // 5. Aceleração (Derivada Segunda aproximada)
    const splitIndex = Math.floor(history.length * 0.7);
    const oldPart = history.slice(0, splitIndex);
    const newPart = history.slice(splitIndex);

    let acceleration = 0;
    if (oldPart.length > 2 && newPart.length > 2) {
        const slopeOld = ss.linearRegression(oldPart.map(h => [(h.ts - oldPart[0].ts) / 60000, h.temp])).m;
        const slopeNew = ss.linearRegression(newPart.map(h => [(h.ts - newPart[0].ts) / 60000, h.temp])).m;
        acceleration = slopeNew - slopeOld; // Se positivo, está acelerando o aquecimento
    }

    // 6. Segunda Derivada (Jerk) - Mudança na aceleração
    let jerk = 0;
    if (history.length >= 9) {
        const third1 = history.slice(0, Math.floor(history.length / 3));
        const third2 = history.slice(Math.floor(history.length / 3), Math.floor(history.length * 2 / 3));
        const third3 = history.slice(Math.floor(history.length * 2 / 3));
        
        if (third1.length > 1 && third2.length > 1 && third3.length > 1) {
            const slope1 = ss.linearRegression(third1.map(h => [(h.ts - third1[0].ts) / 60000, h.temp])).m;
            const slope2 = ss.linearRegression(third2.map(h => [(h.ts - third2[0].ts) / 60000, h.temp])).m;
            const slope3 = ss.linearRegression(third3.map(h => [(h.ts - third3[0].ts) / 60000, h.temp])).m;
            
            const accel1 = slope2 - slope1;
            const accel2 = slope3 - slope2;
            jerk = accel2 - accel1; // Mudança na aceleração
        }
    }

    // 7. Média Móvel Exponencial (EMA) - Suavização
    const ema = calcularEMA(history, TUNING.EMA_ALPHA);

    // 8. Análise de Ciclo de Degelo
    const cicloDegelo = analisarCicloDegelo(history, isUltra);

    // 9. Detecção de Mudança de Ponto
    const changePoint = detectarMudancaPonto(history);

    // 10. Análise de Tendência por Segmentos (para detectar padrões complexos)
    let segmentAnalysis = null;
    if (changePoint && changePoint > 3 && changePoint < history.length - 3) {
        const seg1 = history.slice(0, changePoint);
        const seg2 = history.slice(changePoint);
        const slope1 = ss.linearRegression(seg1.map(h => [(h.ts - seg1[0].ts) / 60000, h.temp])).m;
        const slope2 = ss.linearRegression(seg2.map(h => [(h.ts - seg2[0].ts) / 60000, h.temp])).m;
        segmentAnalysis = { changePoint, slope1, slope2, slopeChange: slope2 - slope1 };
        
        logDebug('ANALISE', 'Mudança de ponto detectada', { 
            mac, 
            ponto: changePoint, 
            slope_antes: slope1.toFixed(3), 
            slope_depois: slope2.toFixed(3),
            mudanca: slope2 - slope1 
        });
    }

    const resultado = { 
        ready: true, 
        slope: line.m,              // °C/min
        acceleration: acceleration, // Mudança no slope
        jerk: jerk,                 // Mudança na aceleração
        stdError: stdError,         // Turbulência (erro padrão)
        variance: variance,          // Dispersão dos dados
        stdDev: stdDev,             // Desvio padrão
        r2: r2,                     // Confiança (0.0 a 1.0)
        avg: ss.mean(temps),
        ema: ema,                   // Média móvel exponencial
        cicloDegelo: cicloDegelo,   // Análise de ciclo completo
        changePoint: changePoint,   // Ponto de mudança detectado
        segmentAnalysis: segmentAnalysis, // Análise por segmentos
        last_ts: history[history.length - 1].ts,
        history_length: history.length
    };
    
    // Log detalhado das métricas calculadas
    logDebug('ANALISE', 'Métricas calculadas', {
        mac,
        temp_atual: tempAtual,
        slope: line.m.toFixed(3),
        r2: r2.toFixed(3),
        variance: variance.toFixed(3),
        std_error: stdError.toFixed(3),
        acceleration: acceleration.toFixed(3),
        jerk: jerk.toFixed(3),
        ema: ema ? ema.toFixed(2) : null,
        pontos_historico: history.length,
        fase_ciclo: cicloDegelo?.phase || 'N/A',
        is_ultra: isUltra
    });
    
    return resultado;
};

// ============================================================================
// 7. ANÁLISE DE ALERTAS E ESTADOS (LÓGICA AVANÇADA)
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

    const ctrl = alertControl.get(sensorMac) || { last_virtual_state: false, is_defrosting: false };
    const val = Number(leitura.temp);

    // --- DEFINIÇÃO DE PERFIL (NORMAL vs ULTRA) ---
    // Se o setpoint minimo for menor que -15, tratamos como ultracongelador (mais sensível a degelo)
    const isUltra = (config.temp_min && config.temp_min < -15);
    const TUNING = isUltra ? TUNING_ULTRA : TUNING_NORMAL;

    // Limites de Alerta
    const diaHoje = moment(now).tz(TIMEZONE_CONFIG).day();
    const isAltoFluxo = DAYS_HIGH_TRAFFIC.includes(diaHoje);
    const LIMIT_TEMP_MAX = config.temp_max !== null ? config.temp_max : (isAltoFluxo ? ENV_TEMP_MAX_HIGH_TRAFFIC : ENV_TEMP_MAX_NORMAL);
    const LIMIT_TEMP_MIN = config.temp_min !== null ? config.temp_min : ENV_TEMP_MIN_GLOBAL;

    let mensagemProblema = null;
    let prioridade = 'ALTA';
    let dadosPrevisao = null;
    let desvioExtremo = false;

    // --- ANÁLISE TÉRMICA AVANÇADA ---
    const iaStats = analisarTendencia(sensorMac, val, isUltra);

    if (iaStats.ready) {
        
        // 1. DETECÇÃO AVANÇADA DE CICLO DE DEGELO
        
        // Rastreamento de estado do degelo
        const defrostStartTime = ctrl.defrost_start_ts || 0;
        const defrostDuration = now - defrostStartTime;
        
        // Critérios múltiplos para detecção de degelo (mais robusto)
        const isRising = iaStats.slope > TUNING.DEFROST_MIN_SLOPE;
        const isStableRise = iaStats.stdError < TUNING.DEFROST_VARIANCE_THRESHOLD && 
                            iaStats.r2 > TUNING.DEFROST_MIN_R2;
        const hasLowVariance = iaStats.variance < TUNING.DEFROST_VARIANCE_THRESHOLD;
        
        // Análise de ciclo completo de degelo (especialmente para ultracongeladores)
        const hasDefrostCycle = iaStats.cicloDegelo && iaStats.cicloDegelo.isDefrostPattern;
        const isInRisingPhase = iaStats.cicloDegelo && iaStats.cicloDegelo.phase === 'RISING';
        const isInFallingPhase = iaStats.cicloDegelo && iaStats.cicloDegelo.phase === 'FALLING';
        const isAtPeak = iaStats.cicloDegelo && iaStats.cicloDegelo.phase === 'PEAK';
        
        // DETECÇÃO DE INÍCIO DE DEGELO (múltiplos critérios)
        if (!ctrl.is_defrosting) {
            // Critério 1: Subida linear estável (método original melhorado)
            const criteria1 = isRising && isStableRise && hasLowVariance;
            
            // Critério 2: Padrão de ciclo de degelo detectado (novo - mais confiável)
            const criteria2 = hasDefrostCycle && isInRisingPhase && 
                             iaStats.cicloDegelo.risingSlope > TUNING.DEFROST_MIN_SLOPE;
            
            // Critério 3: Para ultracongeladores, aceita slope mais alto com R² bom
            const criteria3 = isUltra && isRising && iaStats.r2 > 0.88 && 
                             iaStats.slope > 0.3 && iaStats.stdError < 0.6;
            
            if (criteria1 || criteria2 || criteria3) {
                ctrl.is_defrosting = true;
                ctrl.defrost_start_ts = now;
                ctrl.defrost_start_temp = val;
                ctrl.defrost_peak_temp = val;
                ctrl.defrost_just_started = true; // Flag para evitar verificação de fim no mesmo ciclo
                
                const criterioUsado = criteria1 ? 'CRIT1' : (criteria2 ? 'CRIT2' : 'CRIT3');
                logger.info(`❄️ [DEGELO INICIO] ${nome}`, {
                    criterio: criterioUsado,
                    slope: iaStats.slope.toFixed(3),
                    r2: iaStats.r2.toFixed(3),
                    variance: iaStats.variance.toFixed(3),
                    std_error: iaStats.stdError.toFixed(3),
                    temp_inicio: val,
                    is_ultra: isUltra,
                    fase_ciclo: iaStats.cicloDegelo?.phase || 'N/A',
                    rising_slope: iaStats.cicloDegelo?.risingSlope?.toFixed(3) || 'N/A'
                });
                
                // Salva o controle imediatamente para evitar verificação de fim no mesmo ciclo
                alertControl.set(sensorMac, ctrl);
            } else {
                logDebug('DEGELO', 'Critérios de início não atendidos', {
                    nome,
                    criteria1,
                    criteria2,
                    criteria3,
                    slope: iaStats.slope.toFixed(3),
                    r2: iaStats.r2.toFixed(3),
                    variance: iaStats.variance.toFixed(3)
                });
            }
        }
        
        // DETECÇÃO DE FIM DE DEGELO (múltiplos critérios)
        if (ctrl.is_defrosting) {
            // PROTEÇÃO CRÍTICA: Não verifica fim se degelo acabou de iniciar neste ciclo
            // Isso evita que degelo inicie e termine no mesmo segundo
            if (ctrl.defrost_just_started) {
                logDebug('DEGELO', 'Degelo recém-iniciado - ignorando verificação de fim neste ciclo', {
                    nome,
                    temp_atual: val.toFixed(1),
                    temp_inicio: ctrl.defrost_start_temp?.toFixed(1)
                });
                ctrl.defrost_just_started = false; // Remove flag para próximo ciclo
                alertControl.set(sensorMac, ctrl);
            } else {
                // PROTEÇÃO: Não permite fim de degelo imediatamente após início
                // Evita detecção errônea quando degelo acaba de começar
                const MIN_DEFROST_DURATION_BEFORE_END_MS = 2 * 60 * 1000; // Mínimo 2 minutos antes de permitir fim
                
                // Recalcula duração com o timestamp atualizado
                const defrostDurationRecalc = now - (ctrl.defrost_start_ts || now);
                
                // Atualiza temperatura de pico durante degelo
                if (val > (ctrl.defrost_peak_temp || val)) {
                    ctrl.defrost_peak_temp = val;
                }
                
                // Se degelo acabou de começar, não verifica fim ainda (proteção contra falsos positivos)
                if (defrostDurationRecalc < MIN_DEFROST_DURATION_BEFORE_END_MS) {
                    logDebug('DEGELO', 'Degelo muito recente - ignorando verificação de fim', {
                        nome,
                        duracao_seg: Math.floor(defrostDurationRecalc / 1000),
                        temp_atual: val.toFixed(1),
                        temp_inicio: ctrl.defrost_start_temp?.toFixed(1)
                    });
                } else {
                // Critério 1: Descida forte e consistente (método original)
                const criteria1 = iaStats.slope < -0.3 && iaStats.r2 > 0.7;
                
                // Critério 2: Fase de descida do ciclo detectada (mas só se não estiver em fase RISING)
                // Proteção adicional: não termina degelo se ainda está na fase de subida
                const criteria2 = isInFallingPhase && 
                                 !isInRisingPhase && // Não termina se ainda está subindo
                                 iaStats.cicloDegelo && 
                                 iaStats.cicloDegelo.fallingSlope < -0.15;
                
                    // Critério 3: Degelo muito longo (timeout de segurança)
                    const criteria3 = defrostDurationRecalc > DEFROST_CYCLE_MAX_DURATION_MS;
                    
                    // Critério 4: Temperatura voltou próxima do início do degelo (ultracongeladores)
                    // Mas só se já passou tempo suficiente e está realmente descendo
                    const tempRise = (ctrl.defrost_peak_temp || val) - (ctrl.defrost_start_temp || val);
                    const tempRecovered = val <= (ctrl.defrost_start_temp || val) + (isUltra ? 3.0 : 2.0);
                    const criteria4 = tempRecovered && 
                                     defrostDurationRecalc > DEFROST_CYCLE_MIN_DURATION_MS && 
                                     iaStats.slope < -0.1 &&
                                     !isInRisingPhase; // Não termina se ainda está na fase de subida
                    
                    if (criteria1 || criteria2 || criteria3 || criteria4) {
                        const durationMin = Math.floor(defrostDurationRecalc / 60000);
                    const tempRiseFinal = (ctrl.defrost_peak_temp || val) - (ctrl.defrost_start_temp || val);
                    const criterioUsado = criteria1 ? 'CRIT1' : (criteria2 ? 'CRIT2' : (criteria3 ? 'CRIT3' : 'CRIT4'));
                    
                    ctrl.is_defrosting = false;
                    ctrl.defrost_end_ts = now;
                    
                    logger.info(`❄️ [DEGELO FIM] ${nome}`, {
                        criterio: criterioUsado,
                        duracao_min: durationMin,
                        temp_subida: tempRiseFinal.toFixed(1),
                        temp_inicio: ctrl.defrost_start_temp?.toFixed(1),
                        temp_pico: ctrl.defrost_peak_temp?.toFixed(1),
                        temp_fim: val.toFixed(1),
                        slope_atual: iaStats.slope.toFixed(3),
                        falling_slope: iaStats.cicloDegelo?.fallingSlope?.toFixed(3) || 'N/A'
                    });
                    
                    // Limpa dados do ciclo após fim
                    delete ctrl.defrost_start_ts;
                    delete ctrl.defrost_start_temp;
                    delete ctrl.defrost_peak_temp;
                    } else {
                        logDebug('DEGELO', 'Degelo em andamento - critérios de fim não atendidos', {
                            nome,
                            duracao_min: Math.floor(defrostDurationRecalc / 60000),
                            temp_atual: val,
                            slope: iaStats.slope.toFixed(3),
                            criteria1,
                            criteria2,
                            criteria3,
                            criteria4,
                            is_rising_phase: isInRisingPhase,
                            is_falling_phase: isInFallingPhase
                        });
                    }
                }
            }
        }

        // 2. DETECÇÃO AVANÇADA DE PORTA ABERTA
        // Porta aberta gera: Alta variância, aceleração súbita, mudança de ponto, baixo R²
        let currentState = ctrl.last_virtual_state;
        
        // Log quando usa estado carregado do banco pela primeira vez
        if (ctrl.last_porta_state_loaded_ts && !ctrl.last_porta_state_logged) {
            const estadoCarregado = currentState ? 'ABERTA' : 'FECHADA';
            const tempoDesdeCarregamento = Math.floor((now - ctrl.last_porta_state_loaded_ts) / 1000);
            logger.info(`📋 [PORTA ESTADO INICIAL] ${nome}: Porta ${estadoCarregado} (carregado do banco há ${tempoDesdeCarregamento}s)`, {
                estado: estadoCarregado,
                carregado_em: new Date(ctrl.last_porta_state_loaded_ts).toISOString(),
                tempo_desde_carregamento_seg: tempoDesdeCarregamento
            });
            ctrl.last_porta_state_logged = true; // Marca como logado para não repetir
            alertControl.set(sensorMac, ctrl);
        }
        
        // Durante degelo, não detecta porta (degelo tem padrão diferente)
        if (!ctrl.is_defrosting) {
            // VALIDAÇÃO DE RANGE NORMAL: Se temperatura está dentro do range e estável, porta está fechada
            // Isso evita falsos positivos quando a câmara está operando normalmente
            const tempDentroRange = val >= LIMIT_TEMP_MIN && val <= LIMIT_TEMP_MAX;
            const tempEstavel = iaStats.ready && 
                               Math.abs(iaStats.slope) < 0.1 && // Slope baixo = estável
                               iaStats.variance < (TUNING.DOOR_VARIANCE_THRESHOLD * 0.5) && // Variância baixa = estável
                               iaStats.r2 > 0.7; // R² alto = tendência consistente
            
            // Se temperatura está dentro do range e estável, força porta como fechada
            if (tempDentroRange && tempEstavel) {
                if (currentState) {
                    // Se estava aberta mas agora está estável e no range, fecha
                    currentState = false;
                    logger.info(`🔒 [PORTA FECHADA - RANGE OK] ${nome}: Temperatura estável dentro do range`, {
                        temp: val.toFixed(1),
                        temp_min: LIMIT_TEMP_MIN,
                        temp_max: LIMIT_TEMP_MAX,
                        slope: iaStats.slope.toFixed(3),
                        variance: iaStats.variance.toFixed(3),
                        r2: iaStats.r2.toFixed(3)
                    });
                } else {
                    // Já está fechada e continua estável - não faz nada, mas loga para debug
                    logDebug('PORTA', 'Porta fechada - temperatura estável dentro do range', {
                        nome,
                        temp: val.toFixed(1),
                        slope: iaStats.slope.toFixed(3),
                        variance: iaStats.variance.toFixed(3)
                    });
                }
            } else {
                // ABERTURA DE PORTA (múltiplos critérios para reduzir falsos positivos)
                // Só detecta abertura se temperatura NÃO está estável dentro do range
                if (!currentState) {
                    // Critério 1: Aceleração súbita alta (mudança rápida de temperatura)
                    const criteria1 = iaStats.acceleration > TUNING.DOOR_ACCEL;
                    
                    // Critério 2: Slope muito alto (subida violenta)
                    const criteria2 = iaStats.slope > TUNING.DOOR_SLOPE;
                    
                    // Critério 3: Alta variância + slope positivo (turbulência de ar externo)
                    const criteria3 = iaStats.variance > TUNING.DOOR_VARIANCE_THRESHOLD && 
                                     iaStats.slope > 0.5 && 
                                     iaStats.r2 < 0.6; // Baixa correlação = ruído/turbulência
                    
                    // Critério 4: Mudança de ponto detectada + alta variância (novo)
                    const criteria4 = iaStats.changePoint && 
                                     iaStats.segmentAnalysis &&
                                     Math.abs(iaStats.segmentAnalysis.slopeChange) > 1.0 &&
                                     iaStats.variance > TUNING.DOOR_VARIANCE_THRESHOLD;
                    
                    // Critério 5: Jerk alto (mudança abrupta na aceleração)
                    const criteria5 = Math.abs(iaStats.jerk) > 0.5 && iaStats.slope > 0.3;
                    
                    if (criteria1 || criteria2 || criteria3 || criteria4 || criteria5) {
                    currentState = true;
                    const criterioUsado = criteria1 ? 'CRIT1' : (criteria2 ? 'CRIT2' : (criteria3 ? 'CRIT3' : (criteria4 ? 'CRIT4' : 'CRIT5')));
                    logger.info(`🔓 [PORTA ABERTA] ${nome}`, {
                        criterio: criterioUsado,
                        slope: iaStats.slope.toFixed(3),
                        acceleration: iaStats.acceleration.toFixed(3),
                        variance: iaStats.variance.toFixed(3),
                        r2: iaStats.r2.toFixed(3),
                        jerk: iaStats.jerk?.toFixed(3) || 'N/A',
                        temp: val.toFixed(1)
                    });
                } else {
                    logDebug('PORTA', 'Critérios de abertura não atendidos', {
                        nome,
                        criteria1,
                        criteria2,
                        criteria3,
                        criteria4,
                        criteria5,
                        slope: iaStats.slope.toFixed(3),
                        variance: iaStats.variance.toFixed(3),
                        temp_dentro_range: tempDentroRange,
                        temp_estavel: tempEstavel
                    });
                }
                }
                
                // FECHAMENTO DE PORTA (Recuperação térmica)
                if (currentState) {
                    // Critério 1: Slope negativo consistente (resfriamento)
                    const criteria1 = iaStats.slope < -0.1 && iaStats.r2 > 0.5;
                    
                    // Critério 2: Aceleração negativa (desacelerando a subida)
                    const criteria2 = iaStats.slope < 0.1 && iaStats.acceleration < -0.1;
                    
                    // Critério 3: Variância reduzindo (turbulência diminuindo)
                    const prevVariance = ctrl.last_variance || iaStats.variance;
                    const criteria3 = iaStats.variance < prevVariance * 0.7 && 
                                     iaStats.variance < TUNING.DOOR_VARIANCE_THRESHOLD * 0.8;
                    
                    if (criteria1 || criteria2 || criteria3) {
                        currentState = false;
                        const criterioUsado = criteria1 ? 'CRIT1' : (criteria2 ? 'CRIT2' : 'CRIT3');
                        logger.info(`🔒 [PORTA FECHADA] ${nome}`, {
                            criterio: criterioUsado,
                            slope: iaStats.slope.toFixed(3),
                            acceleration: iaStats.acceleration.toFixed(3),
                            variance: iaStats.variance.toFixed(3),
                            variance_anterior: ctrl.last_variance?.toFixed(3) || 'N/A',
                            temp: val.toFixed(1)
                        });
                    } else {
                        logDebug('PORTA', 'Porta ainda aberta - critérios de fechamento não atendidos', {
                            nome,
                            criteria1,
                            criteria2,
                            criteria3,
                            slope: iaStats.slope.toFixed(3),
                            variance: iaStats.variance.toFixed(3)
                        });
                    }
                }
            }
            
            // Armazena variância para comparação futura
            ctrl.last_variance = iaStats.variance;
        } else {
            // Durante degelo, força porta como fechada (degelo tem padrão controlado)
            currentState = false;
        }

        // Mudança de Estado de Porta
        if (currentState !== ctrl.last_virtual_state) {
            const acao = currentState ? 'ABRIU 🔓' : 'FECHOU 🔒';
            logger.info(`🔄 [ESTADO] ${nome}: ${acao}`, {
                slope: iaStats.slope.toFixed(3),
                acceleration: iaStats.acceleration.toFixed(3),
                std_error: iaStats.stdError.toFixed(3),
                variance: iaStats.variance.toFixed(3),
                r2: iaStats.r2.toFixed(3),
                temp: val.toFixed(1)
            });
            
            dbDoorBuffer.push({
                gateway_mac: gatewayMac || "GW-UNKNOWN",
                sensor_mac: sensorMac, 
                timestamp_read: new Date().toISOString(),
                is_open: currentState,
                alarm_code: currentState ? 1 : 0,
                battery_percent: calcularBateria(leitura.vbatt),
                rssi: leitura.rssi
                // Nota: Métricas de IA (slope, accel, r2, variance, jerk) são logadas mas não salvas no banco
                // pois a coluna extra_data não existe na tabela door_logs
            });
            
            logDebug('DB', 'Evento de porta adicionado ao buffer', {
                sensor: sensorMac,
                is_open: currentState,
                buffer_size: dbDoorBuffer.length
            });
        }
        
        ctrl.last_virtual_state = currentState;
        ctrl.last_analysis_ts = now;
        alertControl.set(sensorMac, ctrl);

        // 3. ALERTAS E LIMITES (COM SUPressão COMPLETA DURANTE DEGELO)
        
        // *** CRÍTICO: Durante degelo, NÃO gera alertas de temperatura alta ***
        // Degelo é um processo controlado e esperado, especialmente em ultracongeladores
        if (ctrl.is_defrosting) {
            // Durante degelo, apenas alerta se temperatura ficar MUITO extrema
            // (possível falha no sistema de degelo ou compressor)
            const defrostTolerance = isUltra ? 25.0 : 15.0; // Tolerância maior para degelo
            
            // Apenas alerta se temperatura subir além do esperado para degelo
            if (val > (LIMIT_TEMP_MAX + defrostTolerance + 5.0)) {
                mensagemProblema = `⚠️ DEGELO ANORMAL: ${val}°C (Max esperado: ${(LIMIT_TEMP_MAX + defrostTolerance).toFixed(1)}°C)`;
                prioridade = 'ALTA';
                desvioExtremo = true;
            }
            // Ou se temperatura ficar muito baixa durante degelo (anormal)
            else if (val < (LIMIT_TEMP_MIN - 5.0)) {
                mensagemProblema = `⚠️ TEMP EXTREMA durante degelo: ${val}°C`;
                prioridade = 'ALTA';
            }
            // Caso contrário, suprime todos os alertas durante degelo
            else {
                // Limpa watchlist se estava em alerta antes do degelo
                if (alertWatchlist.has(sensorMac)) {
                    alertWatchlist.delete(sensorMac);
                    logger.info(`💚 [DEGELO] ${nome}: Alertas suprimidos durante ciclo de degelo`, {
                        temp_atual: val.toFixed(1),
                        temp_max: LIMIT_TEMP_MAX,
                        tolerance: defrostTolerance.toFixed(1),
                        duracao_min: Math.floor(defrostDuration / 60000)
                    });
                }
                // Não retorna alerta - degelo é processo normal
                mensagemProblema = null;
                logDebug('ALERTA', 'Alerta suprimido durante degelo', {
                    nome,
                    temp: val.toFixed(1),
                    temp_max: LIMIT_TEMP_MAX,
                    tolerance: defrostTolerance.toFixed(1)
                });
            }
        } 
        // Fora do degelo, aplica lógica normal de alertas
        else {
            // Limite Absoluto Inferior
            if (val < LIMIT_TEMP_MIN) {
                mensagemProblema = `Temp BAIXA: ${val}°C (Min: ${LIMIT_TEMP_MIN}°C)`;
                if (val < (LIMIT_TEMP_MIN - EXTREME_DEVIATION_C)) desvioExtremo = true;
            } 
            // Limite Absoluto Superior
            else if (val > LIMIT_TEMP_MAX) {
                mensagemProblema = `Temp ALTA: ${val}°C (Max: ${LIMIT_TEMP_MAX}°C)`;
                if (val > (LIMIT_TEMP_MAX + EXTREME_DEVIATION_C)) desvioExtremo = true;
            } 
            // Alerta Preditivo (Tendências) - MODIFICADO
            // Só emite alerta se houver diferença significativa: +5°C (não crítico) ou +10°C (crítico)
            // NÃO emite se estiver em degelo
            // IMPORTANTE: Verifica se iaStats.ready antes de acessar propriedades
            if (iaStats.ready && !ctrl.is_defrosting) {
                const hasDefrostCycleCheck = iaStats.cicloDegelo && iaStats.cicloDegelo.isDefrostPattern;
                
                // Só verifica tendência se não for padrão de degelo e slope for positivo (subindo)
                if (iaStats.slope > 0.1 && iaStats.r2 > 0.6 && !hasDefrostCycleCheck) {
                    const tempFutura15Min = val + (iaStats.slope * 15);
                    
                    // Calcula diferença entre temperatura projetada e limite máximo
                    const diferencaProjetada = tempFutura15Min - LIMIT_TEMP_MAX;
                    
                    // Só alerta se a diferença projetada for significativa
                    // +5°C para não crítico, +10°C para crítico
                    const LIMITE_DIFERENCA_NAO_CRITICO = 5.0;
                    const LIMITE_DIFERENCA_CRITICO = 10.0;
                    
                    if (diferencaProjetada >= LIMITE_DIFERENCA_CRITICO) {
                        // Crítico: diferença >= 10°C
                        const tempoRestante = (LIMIT_TEMP_MAX - val) / iaStats.slope;
                        if (tempoRestante > 0 && tempoRestante < 20) {
                            mensagemProblema = `PREVISÃO CRÍTICA: Atingirá limite em ${Math.floor(tempoRestante)}min (${tempFutura15Min.toFixed(1)}°C, +${diferencaProjetada.toFixed(1)}°C acima do limite)`;
                            prioridade = 'CRITICA';
                            dadosPrevisao = { 
                                tempo_restante: Math.floor(tempoRestante), 
                                temp_projetada: Number(tempFutura15Min.toFixed(2)),
                                diferenca_projetada: Number(diferencaProjetada.toFixed(2)),
                                confianca_r2: Number(iaStats.r2.toFixed(2))
                            };
                        }
                    } else if (diferencaProjetada >= LIMITE_DIFERENCA_NAO_CRITICO) {
                        // Não crítico: diferença >= 5°C mas < 10°C
                        const tempoRestante = (LIMIT_TEMP_MAX - val) / iaStats.slope;
                        if (tempoRestante > 0 && tempoRestante < 20) {
                            mensagemProblema = `PREVISÃO: Atingirá limite em ${Math.floor(tempoRestante)}min (${tempFutura15Min.toFixed(1)}°C, +${diferencaProjetada.toFixed(1)}°C acima do limite)`;
                            prioridade = 'PREDITIVA';
                            dadosPrevisao = { 
                                tempo_restante: Math.floor(tempoRestante), 
                                temp_projetada: Number(tempFutura15Min.toFixed(2)),
                                diferenca_projetada: Number(diferencaProjetada.toFixed(2)),
                                confianca_r2: Number(iaStats.r2.toFixed(2))
                            };
                        }
                    } else {
                        // Diferença < 5°C - não emite alerta de tendência
                        logDebug('ALERTA', 'Tendência detectada mas diferença insuficiente para alerta', {
                            nome,
                            temp_atual: val.toFixed(1),
                            temp_projetada: tempFutura15Min.toFixed(1),
                            diferenca_projetada: diferencaProjetada.toFixed(1),
                            limite_max: LIMIT_TEMP_MAX,
                            slope: iaStats.slope.toFixed(3),
                            r2: iaStats.r2.toFixed(3)
                        });
                    }
                }
            } else if (ctrl.is_defrosting && iaStats.ready) {
                // Log quando tendência é detectada mas degelo está ativo (não emite alerta)
                if (iaStats.slope > 0.1 && iaStats.r2 > 0.6) {
                    logDebug('ALERTA', 'Tendência detectada mas degelo ativo - alerta suprimido', {
                        nome,
                        temp_atual: val.toFixed(1),
                        slope: iaStats.slope.toFixed(3),
                        r2: iaStats.r2.toFixed(3),
                        em_degelo: true
                    });
                }
            }
        }
    }

    // Validação de Umidade (se não houver problema térmico)
    if (!mensagemProblema && leitura.humidity !== undefined) {
        const valHum = Number(leitura.humidity);
        const HUM_MAX = config.hum_max;
        const HUM_MIN = config.hum_min;
        if (HUM_MAX && valHum > HUM_MAX) mensagemProblema = `Umid ALTA: ${valHum}%`;
        else if (HUM_MIN && valHum < HUM_MIN) mensagemProblema = `Umid BAIXA: ${valHum}%`;
    }

    // Gestão de Watchlist e Disparo (Soak Time)
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
        logger.info(`👀 [WATCHLIST] ${nome} adicionado à watchlist`, {
            mensagem: mensagemProblema,
            prioridade,
            temp: val.toFixed(1),
            desvio_extremo: desvioExtremo
        });
        return null;
    } else {
        const tempoDecorrido = now - entry.first_seen;
        // Preditiva tem soak time zero ou reduzido? Aqui deixamos padrão, mas pode ajustar.
        const soakNecessario = prioridade === 'PREDITIVA' ? (ALERT_SOAK_TIME_MS / 2) : ALERT_SOAK_TIME_MS;

        if (tempoDecorrido < soakNecessario) return null;
        
        if (tempoDecorrido > CALL_PERSISTENCE_MS && desvioExtremo) {
            prioridade = 'CRITICA'; 
        }

        const lastSent = ctrl.last_alert_sent_ts || 0;
        const cooldownEnvio = prioridade === 'PREDITIVA' ? 60*60000 : 15*60000; // Preditiva avisa menos

        if (now - lastSent > cooldownEnvio) {
            ctrl.last_alert_sent_ts = now;
            alertControl.set(sensorMac, ctrl);
            
            const alerta = {
                sensor_nome: nome,
                sensor_mac: sensorMac,
                prioridade: prioridade,
                mensagens: [mensagemProblema],
                timestamp_iso: moment(now).tz(TIMEZONE_CONFIG).format(),
                dados_contexto: {
                    temp_atual: leitura.temp,
                    previsao: dadosPrevisao,
                    limites: { max: LIMIT_TEMP_MAX, min: LIMIT_TEMP_MIN },
                    status_operacional: ctrl.is_defrosting ? "EM_DEGELO" : "NORMAL",
                    stats_ia: iaStats.ready ? { 
                        slope: iaStats.slope, 
                        r2: iaStats.r2,
                        variance: iaStats.variance,
                        std_error: iaStats.stdError
                    } : { ready: false }
                }
            };
            
            logger.warn(`⚠️ [ALERTA DISPARADO] ${nome}`, {
                prioridade,
                mensagem: mensagemProblema,
                tempo_soak_min: Math.floor(tempoDecorrido / 60000),
                temp: val.toFixed(1),
                desvio_extremo: desvioExtremo, // Corrigido: variável é desvioExtremo (camelCase)
                cooldown_min: Math.floor(cooldownEnvio / 60000)
            });
            
            return alerta;
        } else {
            const cooldownRestante = Math.floor((cooldownEnvio - (now - lastSent)) / 60000);
            logDebug('ALERTA', 'Alerta em cooldown', {
                nome,
                cooldown_restante_min: cooldownRestante,
                tempo_soak_min: Math.floor(tempoDecorrido / 60000)
            });
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
        try {
            const { error } = await supabase.from('telemetry_logs').insert(batch);
            if (error) throw error;
            logger.info(`💾 [DB] Salvos ${batch.length} logs de telemetria`, {
                total: batch.length,
                sensores_unicos: new Set(batch.map(b => b.mac)).size,
                gateways_unicos: new Set(batch.map(b => b.gw)).size
            });
        } catch (e) {
            logger.error(`❌ [DB] Erro ao salvar telemetria: ${e.message}`, { 
                batch_size: batch.length,
                error: e.message 
            });
            // Recoloca no buffer em caso de erro
            dbTelemetryBuffer.unshift(...batch);
        }
    }
    if (dbDoorBuffer.length > 0) {
        const batch = [...dbDoorBuffer];
        dbDoorBuffer = [];
        try {
            const { error } = await supabase.from('door_logs').insert(batch);
            if (error) throw error;
            logger.info(`💾 [DB] Salvos ${batch.length} logs de porta virtual`, {
                total: batch.length,
                aberturas: batch.filter(b => b.is_open).length,
                fechamentos: batch.filter(b => !b.is_open).length
            });
        } catch (e) {
            logger.error(`❌ [DB] Erro ao salvar logs de porta: ${e.message}`, { 
                batch_size: batch.length,
                error: e.message 
            });
            // Recoloca no buffer em caso de erro
            dbDoorBuffer.unshift(...batch);
        }
    }
}, DB_FLUSH_INTERVAL_MS);

setInterval(async () => {
    if (n8nAlertBuffer.length === 0) return;
    
    const payload = [...n8nAlertBuffer];
    const prioridades = payload.reduce((acc, a) => {
        acc[a.prioridade] = (acc[a.prioridade] || 0) + 1;
        return acc;
    }, {});
    
    logger.info(`📦 [N8N] Enviando ${payload.length} alertas acumulados`, {
        total: payload.length,
        prioridades,
        sensores_unicos: new Set(payload.map(a => a.sensor_mac)).size
    });
    
    n8nAlertBuffer = [];
    try {
        const response = await fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                timestamp: new Date().toISOString(), 
                total_alertas: payload.length, 
                is_batched: true, 
                alertas: payload 
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        logger.info(`✅ [N8N] Alertas enviados com sucesso`, {
            total: payload.length,
            status: response.status
        });
    } catch (e) { 
        logger.error(`❌ [N8N] Falha ao enviar alertas: ${e.message}`, { 
            total: payload.length,
            error: e.message,
            stack: e.stack 
        });
        // Recoloca no buffer em caso de erro
        n8nAlertBuffer.unshift(...payload);
    }
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
client.on('connect', async () => {
    logger.info(`✅ [MQTT] Conectado ao broker`, {
        broker: process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com',
        client_id: client.options.clientId,
        topic: TOPIC_DATA
    });
    client.subscribe(TOPIC_DATA);
    logDebug('MQTT', 'Inscrito no tópico', { topic: TOPIC_DATA });
    
    // Carrega cache e estados na conexão MQTT (caso não tenha sido carregado ainda)
    await atualizarCacheSensores(); 
    await carregarUltimoEstadoPortas();
    sincronizarGatewaysConhecidos();
});

client.on('error', (error) => {
    logger.error(`❌ [MQTT] Erro de conexão: ${error.message}`, { error: error.message, stack: error.stack });
});

client.on('offline', () => {
    logger.warn(`⚠️ [MQTT] Cliente desconectado`);
});

client.on('reconnect', () => {
    logger.info(`🔄 [MQTT] Reconectando...`);
});

client.on('message', (topic, message) => {
    if (topic !== TOPIC_DATA) {
        logDebug('MQTT', 'Mensagem recebida em tópico não monitorado', { topic });
        return;
    }
    
    try {
        const payload = JSON.parse(message.toString());
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();
        
        logDebug('MQTT', 'Mensagem MQTT recebida', {
            items_count: items.length,
            topic,
            payload_size: message.length
        });
        
        let sensoresProcessados = 0;
        let sensoresIgnorados = 0;
        let gatewaysProcessados = new Set();
        
        items.forEach(item => {
            const gatewayMac = formatarMac(item.gmac);
            
            if (HARDCODED_BLOCKLIST.includes(gatewayMac)) {
                logDebug('MQTT', 'Gateway na blocklist ignorado', { gateway: gatewayMac });
                return;
            }
            
            if (gatewayMac) {
                gatewayHeartbeats.set(gatewayMac, { last_seen: now });
                gatewaysProcessados.add(gatewayMac);
            }
            
            if (!item.obj || !Array.isArray(item.obj)) {
                logDebug('MQTT', 'Item sem sensores', { gateway: gatewayMac });
                return;
            }
            
            item.obj.forEach(sensor => {
                const mac = formatarMac(sensor.dmac);
                
                if (!mac) {
                    sensoresIgnorados++;
                    return;
                }
                
                if (HARDCODED_BLOCKLIST.includes(mac)) {
                    logDebug('MQTT', 'Sensor na blocklist ignorado', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                if (secondarySensorsBlocklist.has(mac)) {
                    logDebug('MQTT', 'Sensor secundário ignorado', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                const config = configCache.get(mac);
                if (!config) {
                    logDebug('MQTT', 'Sensor não encontrado no cache', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                let last = lastReadings.get(mac) || { ts: 0, db_temp: -999, db_hum: -999, db_ts: 0 };
                const alerta = verificarSensor(mac, sensor, gatewayMac);
                
                if (alerta) {
                    n8nAlertBuffer.push(alerta);
                    logger.warn(`⚠️ [ALERTA] ${config.display_name}: ${alerta.mensagens[0]}`, {
                        sensor: mac,
                        prioridade: alerta.prioridade,
                        buffer_size: n8nAlertBuffer.length
                    });
                }
                
                if (sensor.temp !== undefined) {
                    const diffTemp = Math.abs(sensor.temp - last.db_temp);
                    const diffHum = Math.abs((sensor.humidity || 0) - last.db_hum);
                    const timeSinceLastDB = now - last.db_ts;
                    
                    if (diffTemp >= DB_MIN_VAR_TEMP || diffHum >= DB_MIN_VAR_HUM || timeSinceLastDB > DB_HEARTBEAT_MS) {
                        dbTelemetryBuffer.push({ 
                            gw: item.gmac, 
                            mac: mac, 
                            ts: new Date().toISOString(), 
                            temp: sensor.temp, 
                            hum: sensor.humidity, 
                            batt: calcularBateria(sensor.vbatt), 
                            rssi: sensor.rssi 
                        });
                        
                        logDebug('DB', 'Telemetria adicionada ao buffer', {
                            sensor: mac,
                            temp: sensor.temp,
                            diff_temp: diffTemp.toFixed(2),
                            diff_hum: diffHum.toFixed(2),
                            time_since_last: Math.floor(timeSinceLastDB / 1000),
                            buffer_size: dbTelemetryBuffer.length
                        });
                        
                        last.db_temp = sensor.temp;
                        last.db_hum = sensor.humidity;
                        last.db_ts = now;
                    } else {
                        logDebug('DB', 'Telemetria não salva (variação insuficiente)', {
                            sensor: mac,
                            temp: sensor.temp,
                            diff_temp: diffTemp.toFixed(2),
                            diff_hum: diffHum.toFixed(2),
                            time_since_last: Math.floor(timeSinceLastDB / 1000)
                        });
                    }
                }
                
                last.ts = now;
                lastReadings.set(mac, last);
                sensoresProcessados++;
            });
        });
        
        logDebug('MQTT', 'Mensagem processada', {
            items: items.length,
            sensores_processados: sensoresProcessados,
            sensores_ignorados: sensoresIgnorados,
            gateways: Array.from(gatewaysProcessados),
            buffer_telemetry: dbTelemetryBuffer.length,
            buffer_alertas: n8nAlertBuffer.length
        });
        
    } catch (e) { 
        logger.error(`🔥 [MQTT] Erro ao processar mensagem: ${e.message}`, { 
            error: e.message,
            stack: e.stack,
            message_preview: message.toString().substring(0, 200)
        });
    }
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
app.listen(PORT, () => {
    logger.info(`🚀 Monitor ColdChain Neural v5 Online`, {
        porta: PORT,
        log_level: process.env.LOG_LEVEL || 'debug',
        timezone: TIMEZONE_CONFIG,
        mqtt_broker: process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com',
        predict_window_mins: PREDICT_WINDOW_MINS,
        min_data_points: MIN_DATA_POINTS
    });
});
app.listen(PORT, () => logger.info(`🚀 Monitor ColdChain Neural v5 Online na porta ${PORT}`));