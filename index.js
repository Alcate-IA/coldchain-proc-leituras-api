import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import winston from 'winston';

dotenv.config();

// --- CONFIGURAÇÃO DO LOGGER (WINSTON) ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: winston.format.json() }),
        new winston.transports.File({ filename: 'logs/combined.log', format: winston.format.json() }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `[${timestamp}] ${level}: ${message}`;
                })
            ),
        })
    ],
});

// --- CONSTANTES E CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3030;
const BROKER_URL = 'mqtt://broker.hivemq.com';
const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat';

// Filtros de Gravação (DB)
const DOOR_DEBOUNCE_MS = 5000;      // 5s para gravar alteração de porta
const ANALOG_MAX_AGE_MS = 300000;   // 5min heartbeat gravação
const VAR_TEMP_MIN = 0.5;           // Variação min Temp
const VAR_HUM_MIN = 1.0;            // Variação min Hum

// --- REGRAS DE ALERTA E LISTA DE ACOMPANHAMENTO ---
const WATCHLIST_DELAY_MS = 5 * 60 * 1000; // 5 Min: Tempo de persistência para Temperatura
const ALERT_COOLDOWN = 20 * 60 * 1000;    // 20 Min: Silêncio após enviar alerta
const DOOR_TIME_LIMIT = 5 * 60 * 1000;    // 5 Min: Tempo para considerar porta aberta erro
const TEMP_TOLERANCE = 1.0;               // 1.0°C: Tolerância acima do limite

// Feature Flags
const PROCESS_GPS    = process.env.ENABLE_GPS_DATA === 'true';
const PROCESS_DOORS  = process.env.ENABLE_DOORS === 'true';

// --- ESTADO EM MEMÓRIA ---
const lastReadings = new Map();
const alertControl = new Map();     // Controla o Cooldown de envio
const alertWatchlist = new Map();   // Controla a Lista de Observação
let configCache = new Map();

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = mqtt.connect(BROKER_URL, {
    clientId: 'alcateia_vps_' + Math.random().toString(16).substring(2, 10),
    clean: true,
    reconnectPeriod: 5000
});

app.use(cors());
app.use(express.json());

// --- FUNÇÕES AUXILIARES ---
const formatarMac = (mac) => mac?.includes(':') ? mac : mac?.replace(/(.{2})(?=.)/g, '$1:');

const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const [MAX, MIN] = [3600, 2500];
    return Math.max(0, Math.min(100, Math.round(((mVolts - MIN) / (MAX - MIN)) * 100)));
};

// --- GESTÃO DE CACHE ---
const atualizarCacheConfiguracoes = async () => {
    try {
        const { data: configs, error } = await supabase
            .from('sensor_configs')
            .select('mac, temp_max, hum_max, display_name')
            .eq('em_manutencao', false);

        if (error) throw error;

        const novoCache = new Map();
        configs.forEach(c => novoCache.set(c.mac, c));
        configCache = novoCache;
        logger.info(`🔄 [CACHE] Configurações atualizadas: ${configCache.size} sensores ativos.`);
    } catch (e) {
        logger.error(`❌ [CACHE] Erro ao atualizar: ${e.message}`);
    }
};

// Atualiza cache ao iniciar e a cada 10 min
setTimeout(atualizarCacheConfiguracoes, 1000);
setInterval(atualizarCacheConfiguracoes, 10 * 60 * 1000);

// Rota Manual
app.all('/api/refresh-config', async (req, res) => {
    await atualizarCacheConfiguracoes();
    res.json({ success: true, message: 'Cache atualizado.' });
});

// --- LÓGICA CORE: VERIFICAÇÃO HÍBRIDA ---
const verificarSensorIndividual = (sensorMac, leituraAtual, estadoMemoria) => {
    const config = configCache.get(sensorMac);
    if (!config) return null; 

    const nome = config.display_name || sensorMac;
    let problemasDetectados = [];
    
    // Flag: Se for true, ignora o tempo de espera da watchlist e alerta logo
    let furarFilaWatchlist = false; 

    // 1. ANÁLISE DE TEMPERATURA (Sujeito à Watchlist)
    if (leituraAtual.temp !== undefined && config.temp_max !== null) {
        const tempAtual = Number(leituraAtual.temp);
        const tempLimite = Number(config.temp_max);
        
        // Ex: Limite -5 + 1 = -4. Se temp for -3 (maior que -4), gera alerta.
        if (!isNaN(tempAtual) && !isNaN(tempLimite) && tempAtual > (tempLimite + TEMP_TOLERANCE)) {
            problemasDetectados.push(`temperatura alta de ${tempAtual.toFixed(1)} graus`);
        }
    }

    // 2. ANÁLISE DE PORTA (Prioridade Imediata após timer interno)
    if (leituraAtual.alarm !== undefined) {
        const isOpen = leituraAtual.alarm > 0;
        if (isOpen) {
            // Se abriu agora, marca o tempo
            if (!estadoMemoria.open_since) estadoMemoria.open_since = Date.now();
            
            const tempoAberto = Date.now() - estadoMemoria.open_since;

            // Se estourou o tempo limite da porta (ex: 5 min)
            if (tempoAberto > DOOR_TIME_LIMIT) {
                 const minutos = Math.floor(tempoAberto / 60000);
                 problemasDetectados.push(`porta aberta há ${minutos} minutos`);
                 
                 // Porta aberta por muito tempo é crítico e já tem seu próprio timer.
                 // Não precisamos esperar mais 5 min na watchlist.
                 furarFilaWatchlist = true; 
            }
        } else {
            estadoMemoria.open_since = null;
        }
    }

    // 3. GERENCIAMENTO DA WATCHLIST (LISTA DE ESPERA)
    
    // Se não há problemas, remove da lista e sai
    if (problemasDetectados.length === 0) {
        if (alertWatchlist.has(sensorMac)) {
            logger.info(`🟢 [WATCHLIST] Sensor ${nome} normalizou. Removido da observação.`);
            alertWatchlist.delete(sensorMac);
        }
        return null;
    }

    const now = Date.now();

    // Se NÃO for um alerta de porta (que fura fila), aplicamos a lógica de espera
    if (!furarFilaWatchlist) {
        let watchEntry = alertWatchlist.get(sensorMac);

        if (!watchEntry) {
            // Primeira vez detectando temperatura alta
            alertWatchlist.set(sensorMac, { first_seen: now });
            logger.info(`🟡 [WATCHLIST] ${nome} entrou em observação (Temp Alta). Aguardando confirmação...`);
            return null; // Interrompe aqui. Não alerta ainda.
        } else {
            // Já estava na lista. Verifica há quanto tempo.
            const tempoEmObservacao = now - watchEntry.first_seen;
            if (tempoEmObservacao < WATCHLIST_DELAY_MS) {
                // Ainda não passou os 5 minutos de confirmação
                return null; 
            }
        }
    }
    // Se furarFilaWatchlist == true, ele pula o bloco acima e vai direto para o envio.

    // 4. VERIFICAÇÃO DE COOLDOWN (ENVIO)
    // Evita enviar mensagens repetidas a cada segundo
    const lastAlert = alertControl.get(sensorMac)?.last_alert_ts || 0;
    
    if (now - lastAlert < ALERT_COOLDOWN) {
        return null; // Já enviamos alerta recentemente (nos últimos 20 min)
    }

    // Passou por todos os filtros. Vamos alertar.
    alertControl.set(sensorMac, { last_alert_ts: now });

    return {
        sensor_nome: nome,
        descricao_problemas: problemasDetectados,
        dados_brutos: {
            sensor: nome,
            temp: leituraAtual.temp,
            hum: leituraAtual.humidity,
            limite_temp: config.temp_max,
            limite_tolerancia: (config.temp_max + TEMP_TOLERANCE),
            tipo_alerta: furarFilaWatchlist ? 'CRITICO_PORTA' : 'CONFIRMADO_TEMP'
        }
    };
};

// --- EVENTOS MQTT ---

client.on('connect', () => {
    logger.info(`✅ [MQTT] Conectado! ID: ${client.options.clientId}`);
    client.subscribe(TOPIC_DATA, (err) => {
        if (!err) logger.info(`📡 [MQTT] Inscrito: ${TOPIC_DATA}`);
        else logger.error(`❌ [MQTT] Erro inscrição: ${err.message}`);
    });
});

client.on('message', async (topic, message) => {
    if (topic !== TOPIC_DATA) return;

    try {
        const payload = JSON.parse(message.toString());
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();

        const dbBatchPortas = [];
        const dbBatchTelemetria = [];
        const alertasParaEnviar = [];

        items.forEach((item) => {
            if (item.obj && Array.isArray(item.obj)) {
                const gwMac = formatarMac(item.gmac);
                
                item.obj.forEach(sensor => {
                    const sensorMac = formatarMac(sensor.dmac);
                    const vbatt = calcularBateria(sensor.vbatt);
                    
                    // Recupera ou inicializa estado anterior
                    let last = lastReadings.get(sensorMac) || { temp: 0, hum: 0, state: null, ts: 0, open_since: null };
                    const timeDiff = now - last.ts;

                    // --- A. PROCESSAMENTO DE ALERTAS ---
                    const alerta = verificarSensorIndividual(sensorMac, sensor, last);
                    if (alerta) {
                        alertasParaEnviar.push(alerta);
                    }

                    // --- B. PREPARAÇÃO PARA DB (LOGS) ---
                    // 1. Portas
                    if (PROCESS_DOORS && sensor.alarm !== undefined) {
                        const isOpen = sensor.alarm > 0;
                        if (isOpen !== last.state || timeDiff > DOOR_DEBOUNCE_MS) {
                            dbBatchPortas.push({
                                gateway_mac: gwMac, sensor_mac: sensorMac, timestamp_read: new Date().toISOString(),
                                battery_percent: vbatt, is_open: isOpen, alarm_code: sensor.alarm, rssi: sensor.rssi
                            });
                            last.state = isOpen;
                            last.ts = now;
                        }
                    } 
                    // 2. Telemetria (Temp/Hum/GPS)
                    else if (PROCESS_GPS && (sensor.temp !== undefined)) {
                        const diffTemp = Math.abs(sensor.temp - last.temp);
                        const diffHum = Math.abs((sensor.humidity || 0) - last.hum);
                        if (diffTemp >= VAR_TEMP_MIN || diffHum >= VAR_HUM_MIN || timeDiff > ANALOG_MAX_AGE_MS) {
                            dbBatchTelemetria.push({
                                gw: gwMac, mac: sensorMac, ts: new Date().toISOString(),
                                batt: vbatt, temp: sensor.temp, hum: sensor.humidity, rssi: sensor.rssi,
                                latitude: item.location?.latitude, longitude: item.location?.longitude
                            });
                            last.temp = sensor.temp;
                            last.hum = sensor.humidity;
                            last.ts = now;
                        }
                    }
                    
                    // Salva estado atualizado
                    lastReadings.set(sensorMac, last);
                });
            }
        });

        // --- C. ENVIO PARA N8N ---
        if (alertasParaEnviar.length > 0) {
            const rawData = alertasParaEnviar.map(a => a.dados_brutos);
            
            // Cria texto simples para TTS (Texto para Fala)
            const frases = alertasParaEnviar.map(a => `No ${a.sensor_nome}, ${a.descricao_problemas.join(' e ')}`);
            const ttsMessage = `Atenção. Alertas confirmados: ${frases.join('. ')}.`;

            const payloadN8N = {
                trigger_reason: "validated_alert_report",
                has_alerts: true,
                timestamp: new Date().toISOString(),
                tts_message: ttsMessage,
                alert_count: alertasParaEnviar.length,
                raw_data: rawData
            };

            logger.info(`🚨 [N8N] Enviando ${alertasParaEnviar.length} alertas validados.`);

            fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadN8N)
            }).catch(err => logger.error(`❌ [N8N] Falha no envio: ${err.message}`));
        }

        // --- D. GRAVAÇÃO NO BANCO (ASSÍNCRONA) ---
        if (dbBatchPortas.length > 0) {
            supabase.from('door_logs').insert(dbBatchPortas).then(({error}) => {
                if(error) logger.error(`DB Porta: ${error.message}`);
            });
        }
        if (dbBatchTelemetria.length > 0) {
            supabase.from('telemetry_logs').insert(dbBatchTelemetria).then(({error}) => {
                if(error) logger.error(`DB Telemetria: ${error.message}`);
            });
        }

    } catch (e) {
        logger.error(`❌ Erro no Loop Principal: ${e.message}`);
    }
});

// Logs de conexão
client.on('reconnect', () => logger.warn('⚠️ [MQTT] Reconectando...'));
client.on('offline', () => logger.warn('🔌 [MQTT] Offline.'));
client.on('error', (err) => logger.error(`🔥 [MQTT] Erro: ${err.message}`));

// Inicia servidor Express
app.listen(PORT, () => logger.info(`🚀 API Online na porta ${PORT}`));