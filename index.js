import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import winston from 'winston';

dotenv.config();

// --- CONFIGURAÇÃO DO LOGGER (WINSTON) ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }));
}

// --- CONFIGURAÇÕES E LIMITES DE FILTRO (DEBOUNCING/DEADBAND) ---
const PORT = process.env.PORT || 3030;
const BROKER_URL = 'mqtt://broker.hivemq.com';

const DOOR_DEBOUNCE_MS = 5000;      // 5 segundos para evitar repetições de porta
const ANALOG_MAX_AGE_MS = 300000;   // 5 minutos (força gravação mesmo sem variação)
const VAR_TEMP_MIN = 0.5;           // Delta de 0.5°C para temperatura
const VAR_HUM_MIN = 1.0;            // Delta de 1% para umidade

// Cache de estados: { sensor_mac: { temp, hum, state, ts } }
const lastReadings = new Map();

// --- FEATURE FLAGS ---
const PROCESS_LEGACY = process.env.ENABLE_LEGACY_DATA === 'true'; 
const PROCESS_GPS    = process.env.ENABLE_GPS_DATA === 'true';    
const PROCESS_DOORS  = process.env.ENABLE_DOORS === 'true';       

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat'; 

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = mqtt.connect(BROKER_URL);

app.use(cors());
app.use(express.json());

// --- FUNÇÕES AUXILIARES ---
const formatarMac = (mac) => mac?.includes(':') ? mac : mac?.replace(/(.{2})(?=.)/g, '$1:');

const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const [MAX, MIN] = [3600, 2500];
    return Math.max(0, Math.min(100, Math.round(((mVolts - MIN) / (MAX - MIN)) * 100)));
};

// --- PROCESSAMENTO MQTT ---

client.on('connect', () => {
    logger.info('✅ Conectado ao Broker MQTT!');
    
    client.subscribe(TOPIC_DATA, (err) => {
        if (!err) {
            logger.info(`📡 Inscrito com sucesso no tópico: ${TOPIC_DATA}`);
        } else {
            logger.error(`❌ Erro ao se inscrever no tópico: ${err.message}`);
        }
    });
});

// --- ROTINA: RELATÓRIO PARA AGENTE DE VOZ (VIA N8N) ---
const processarRelatorioVoz = async () => {
    logger.info('🗣️ Verificando dados para o Agente de Voz...');

    // Busca configs apenas de sensores ativos (em_manutencao = false)
    const { data: configs } = await supabase
        .from('sensor_configs')
        .select('*')
        .eq('em_manutencao', false);

    if (!configs || configs.length === 0) {
        // Silencioso se não houver configs, ou loga debug
        return;
    }

    // Busca logs recentes
    const { data: logs } = await supabase
        .from('telemetry_logs')
        .select('mac, temp, hum, ts')
        .order('ts', { ascending: false })
        .limit(2000);

    if (!logs) return;

    // Deduplicação (Última leitura por MAC)
    const ultimasLeituras = new Map();
    logs.forEach(log => {
        if (!ultimasLeituras.has(log.mac)) ultimasLeituras.set(log.mac, log);
    });

    // Construção da Narrativa (Texto para Fala)
    let frasesDeAlerta = [];
    let detalhesTecnicos = []; 

    configs.forEach(config => {
        const leitura = ultimasLeituras.get(config.mac);
        if (!leitura) return;

        const nomeFalado = (config.display_name || "Sensor desconhecido").replace(/_/g, " ");
        let problemasSensor = [];

        // Verifica Temperatura
        if (config.temp_max !== null && leitura.temp > config.temp_max) {
            const valor = leitura.temp.toFixed(1).replace('.', ','); 
            problemasSensor.push(`temperatura alta de ${valor} graus`);
        }

        // Verifica Umidade
        if (config.hum_max !== null && leitura.hum > config.hum_max) {
            const valor = leitura.hum.toFixed(0); 
            problemasSensor.push(`umidade alta de ${valor} por cento`);
        }

        if (problemasSensor.length > 0) {
            frasesDeAlerta.push(`No ${nomeFalado}, foi detectado ${problemasSensor.join(' e ')}.`);
            
            detalhesTecnicos.push({
                sensor: config.display_name,
                temp: leitura.temp,
                hum: leitura.hum,
                limite_temp: config.temp_max
            });
        }
    });

    // Lógica de Disparo
    if (frasesDeAlerta.length === 0) {
        logger.info('✅ Nenhum alerta crítico encontrado. Automação encerrada.');
        return; 
    }

    // Montagem da Mensagem Final
    const saudacao = "Olá, aqui é o monitoramento da Alcateia. Atenção para os seguintes alertas.";
    const corpoMensagem = frasesDeAlerta.join(' Além disso, ');
    const conclusao = "Verifique o painel imediatamente.";
    
    const textoCompletoTTS = `${saudacao} ${corpoMensagem} ${conclusao}`;

    const payload = {
        trigger_reason: "critical_report_voice",
        has_alerts: true,
        timestamp: new Date().toISOString(),
        tts_message: textoCompletoTTS,
        alert_count: frasesDeAlerta.length,
        raw_data: detalhesTecnicos
    };

    try {
        logger.info(`📞 Enviando alerta com ${frasesDeAlerta.length} ocorrências para o n8n...`);
        
        const response = await fetch('https://n8n.alcateia-ia.com/webhook-test/alertas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) logger.info('✅ Webhook acionado com sucesso.');
        else logger.error(`❌ Erro no Webhook n8n: ${response.statusText}`);

    } catch (error) {
        logger.error(`❌ Falha na conexão com n8n: ${error.message}`);
    }
};

// Agendamento do relatório de voz
cron.schedule('*/30 * * * *', () => processarRelatorioVoz());

client.on('message', async (topic, message) => {
    if (topic !== TOPIC_DATA) return;

    try {
        const payload = JSON.parse(message.toString());
        const batchTelemetria = [];
        const batchPortas = [];
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();

        items.forEach((item) => {
            if (item.obj && Array.isArray(item.obj)) {
                const gwMac = formatarMac(item.gmac);
                
                item.obj.forEach(sensor => {
                    const sensorMac = formatarMac(sensor.dmac);
                    const vbatt = calcularBateria(sensor.vbatt);
                    const last = lastReadings.get(sensorMac) || { temp: 0, hum: 0, state: null, ts: 0 };
                    const timeDiff = now - last.ts;

                    // 1. PROCESSAMENTO DE PORTAS
                    if (PROCESS_DOORS && sensor.alarm !== undefined) {
                        const isOpen = sensor.alarm > 0;
                        if (isOpen !== last.state || timeDiff > DOOR_DEBOUNCE_MS) {
                            batchPortas.push({
                                gateway_mac: gwMac, 
                                sensor_mac: sensorMac,
                                timestamp_read: new Date().toISOString(),
                                battery_percent: vbatt, 
                                is_open: isOpen, 
                                alarm_code: sensor.alarm,
                                rssi: sensor.rssi
                            });
                            lastReadings.set(sensorMac, { ...last, state: isOpen, ts: now });
                        }
                    } 
                    
                    // 2. PROCESSAMENTO DE TELEMETRIA
                    else if (PROCESS_GPS && (sensor.temp !== undefined)) {
                        const diffTemp = Math.abs(sensor.temp - last.temp);
                        const diffHum = Math.abs((sensor.humidity || 0) - last.hum);

                        if (diffTemp >= VAR_TEMP_MIN || diffHum >= VAR_HUM_MIN || timeDiff > ANALOG_MAX_AGE_MS) {
                            batchTelemetria.push({
                                gw: gwMac, 
                                mac: sensorMac, 
                                ts: new Date().toISOString(),
                                batt: vbatt, 
                                temp: sensor.temp, 
                                hum: sensor.humidity,
                                rssi: sensor.rssi,
                                latitude: (item.location?.err === 0) ? item.location.latitude : null,
                                longitude: (item.location?.err === 0) ? item.location.longitude : null
                            });
                            lastReadings.set(sensorMac, { ...last, temp: sensor.temp, hum: sensor.humidity, ts: now });
                        }
                    }
                });
            }
        });

        // Gravação no Banco Supabase
        if (batchPortas.length > 0) {
            const { error } = await supabase.from('door_logs').insert(batchPortas);
            if (!error) logger.info(`🚪 ${batchPortas.length} logs de porta salvos.`);
            else logger.error(`❌ Erro Supabase Porta: ${error.message}`);
        }

        if (batchTelemetria.length > 0) {
            // Removido processarAlertas e insert em critical_logs aqui
            
            const { error } = await supabase.from('telemetry_logs').insert(batchTelemetria);
            if (!error) logger.info(`🌡️ ${batchTelemetria.length} logs de telemetria salvos.`);
            else logger.error(`❌ Erro Supabase Telemetria: ${error.message}`);
        }

    } catch (e) {
        logger.error('❌ Erro no processamento da mensagem: %s', e.message);
    }
});

app.listen(PORT, () => logger.info(`🚀 API Online na porta ${PORT}`));