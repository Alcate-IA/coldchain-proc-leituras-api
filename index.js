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

// Regras de Alerta (Memória)
const ALERT_COOLDOWN = 20 * 60 * 1000; // 20 minutos de silêncio para o MESMO sensor
const DOOR_TIME_LIMIT = 5 * 60 * 1000; // 5 minutos porta aberta para gerar alerta

// Feature Flags
const PROCESS_GPS    = process.env.ENABLE_GPS_DATA === 'true';
const PROCESS_DOORS  = process.env.ENABLE_DOORS === 'true';

// --- ESTADO EM MEMÓRIA ---
const lastReadings = new Map();
const alertControl = new Map();
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

// --- GESTÃO DE CACHE DE CONFIGURAÇÕES ---
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

// Rota para Refresh Manual
app.all('/api/refresh-config', async (req, res) => {
    logger.info('🔄 [API] Solicitação manual de atualização de cache recebida.');
    await atualizarCacheConfiguracoes();
    res.json({ success: true, message: 'Cache atualizado.', sensores_ativos: configCache.size });
});

setTimeout(atualizarCacheConfiguracoes, 1000);
setInterval(atualizarCacheConfiguracoes, 10 * 60 * 1000);

// --- LÓGICA DE VERIFICAÇÃO DE REGRAS ---
const verificarSensorIndividual = (sensorMac, leituraAtual, estadoMemoria) => {
    const config = configCache.get(sensorMac);
    if (!config) return null; 

    let falhas = [];
    const nome = config.display_name || sensorMac;

    // 1. Temperatura
    if (leituraAtual.temp !== undefined && config.temp_max !== null) {
        if (leituraAtual.temp > config.temp_max) {
            falhas.push(`temperatura alta de ${leituraAtual.temp.toFixed(1)} graus`);
        }
    }

    // 2. Umidade
    if (leituraAtual.humidity !== undefined && config.hum_max !== null) {
        if (leituraAtual.humidity > config.hum_max) {
            falhas.push(`umidade alta de ${leituraAtual.humidity.toFixed(0)} por cento`);
        }
    }

    // 3. Porta
    if (leituraAtual.alarm !== undefined) {
        const isOpen = leituraAtual.alarm > 0;
        if (isOpen) {
            if (!estadoMemoria.open_since) estadoMemoria.open_since = Date.now();
            const tempoAberto = Date.now() - estadoMemoria.open_since;
            if (tempoAberto > DOOR_TIME_LIMIT) {
                const minutos = Math.floor(tempoAberto / 60000);
                falhas.push(`porta aberta há ${minutos} minutos`);
            }
        } else {
            estadoMemoria.open_since = null;
        }
    }

    if (falhas.length === 0) return null;

    // 4. Cooldown
    const lastAlert = alertControl.get(sensorMac)?.last_alert_ts || 0;
    const now = Date.now();

    if (now - lastAlert < ALERT_COOLDOWN) return null;

    alertControl.set(sensorMac, { last_alert_ts: now });

    // RETORNA DADOS NECESSÁRIOS PARA O PAYLOAD
    return {
        sensor_nome: nome,
        descricao_problemas: falhas, // Array de strings formatadas para voz
        
        // Dados crus para raw_data
        dados_brutos: {
            sensor: nome,
            temp: leituraAtual.temp,
            hum: leituraAtual.humidity,
            limite_temp: config.temp_max,
            limite_hum: config.hum_max
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
        const payloadStr = message.toString();
        const payload = JSON.parse(payloadStr);
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();

        logger.info(`📥 [MQTT] Recebido pacote com ${items.length} gateway(s).`);

        const dbBatchPortas = [];
        const dbBatchTelemetria = [];
        const alertasConsolidados = [];
        let sensoresProcessadosCount = 0;

        items.forEach((item) => {
            if (item.obj && Array.isArray(item.obj)) {
                const gwMac = formatarMac(item.gmac);
                sensoresProcessadosCount += item.obj.length;

                item.obj.forEach(sensor => {
                    const sensorMac = formatarMac(sensor.dmac);
                    const vbatt = calcularBateria(sensor.vbatt);
                    
                    let last = lastReadings.get(sensorMac) || { temp: 0, hum: 0, state: null, ts: 0, open_since: null };
                    const timeDiff = now - last.ts;

                    // --- A. ALERTAS ---
                    const alertaSensor = verificarSensorIndividual(sensorMac, sensor, last);
                    if (alertaSensor) {
                        alertasConsolidados.push(alertaSensor);
                    }

                    // --- B. GRAVAÇÃO DB ---
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

                    // 2. Telemetria
                    else if (PROCESS_GPS && (sensor.temp !== undefined)) {
                        const diffTemp = Math.abs(sensor.temp - last.temp);
                        const diffHum = Math.abs((sensor.humidity || 0) - last.hum);

                        if (diffTemp >= VAR_TEMP_MIN || diffHum >= VAR_HUM_MIN || timeDiff > ANALOG_MAX_AGE_MS) {
                            dbBatchTelemetria.push({
                                gw: gwMac, mac: sensorMac, ts: new Date().toISOString(),
                                batt: vbatt, temp: sensor.temp, hum: sensor.humidity, rssi: sensor.rssi,
                                latitude: (item.location?.err === 0) ? item.location.latitude : null,
                                longitude: (item.location?.err === 0) ? item.location.longitude : null
                            });
                            last.temp = sensor.temp;
                            last.hum = sensor.humidity;
                            last.ts = now;
                        }
                    }
                    lastReadings.set(sensorMac, last);
                });
            }
        });

        // --- C. AÇÕES FINAIS (ENVIO N8N FORMATADO) ---

        if (alertasConsolidados.length > 0) {
            const qtd = alertasConsolidados.length;

            // 1. Constrói o raw_data (Array Limpo)
            const rawData = alertasConsolidados.map(a => a.dados_brutos);

            // 2. Constrói a mensagem de voz (TTS)
            const frasesDetalhadas = alertasConsolidados.map(a => {
                // "No [Sensor], foi detectado [temp alta] e [porta aberta]"
                return `No ${a.sensor_nome}, foi detectado ${a.descricao_problemas.join(' e ')}`;
            });

            const ttsMessage = `Olá, aqui é o monitoramento da Alcateia. Atenção para os seguintes alertas. ${frasesDetalhadas.join('. ')}. Verifique o painel imediatamente.`;

            // 3. Monta o Payload Final
            const payloadN8N = {
                trigger_reason: "critical_report_voice",
                has_alerts: true,
                timestamp: new Date().toISOString(),
                tts_message: ttsMessage,
                alert_count: qtd,
                raw_data: rawData
            };

            logger.info(`🚨 [N8N] Enviando ${qtd} alertas...`);

            fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadN8N)
            }).catch(err => logger.error(`❌ [N8N] Falha: ${err.message}`));

        } else {
            logger.info(`✅ [STATUS] Processados ${sensoresProcessadosCount} sensores. Nenhum alerta crítico.`);
        }

        // Gravação DB (Mantida igual)
        if (dbBatchPortas.length > 0) {
            supabase.from('door_logs').insert(dbBatchPortas)
                .then(({ error }) => { 
                    if (error) logger.error(`❌ DB Porta: ${error.message}`);
                    else logger.info(`🚪 [DB] ${dbBatchPortas.length} logs de porta salvos.`);
                });
        }

        if (dbBatchTelemetria.length > 0) {
            supabase.from('telemetry_logs').insert(dbBatchTelemetria)
                .then(({ error }) => { 
                    if (error) logger.error(`❌ DB Telemetria: ${error.message}`);
                    else logger.info(`🌡️ [DB] ${dbBatchTelemetria.length} logs de telemetria salvos.`);
                });
        }

    } catch (e) {
        logger.error(`❌ Erro Processamento MSG: ${e.message}`);
    }
});

client.on('reconnect', () => logger.warn('⚠️ [MQTT] Reconectando...'));
client.on('offline', () => logger.warn('🔌 [MQTT] Offline.'));
client.on('error', (err) => logger.error(`🔥 [MQTT] Erro: ${err.message}`));

// --- INICIALIZAÇÃO DO SERVIDOR EXPRESS ---
app.listen(PORT, () => logger.info(`🚀 API Online na porta ${PORT}`));