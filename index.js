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
const ENABLE_ALERTS  = process.env.ENABLE_ALERTS === 'true';      

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat'; 
const TOPIC_ALERTS = '/alcateia/alerts/summary';

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

// --- LOGICA DE ALERTAS CRÍTICOS ---
const classificarSeveridade = (tipo, valor, limite) => {
    if (tipo === 'Temperatura') {
        const delta = valor - limite;
        if (delta <= 0.5) return null;
        if (delta < 2.0) return 'LEVE';
        if (delta < 5.0) return 'MEDIA';
        return 'URGENTE';
    }
    if (tipo === 'Umidade') {
        const delta = valor - limite;
        if (delta <= 1.0) return null;
        if (delta < 10) return 'LEVE';
        if (delta < 20) return 'MEDIA';
        return 'URGENTE';
    }
    return 'LEVE';
};

const processarAlertas = async (leituras) => {
    if (leituras.length === 0) return;
    const macs = [...new Set(leituras.map(l => l.mac))];
    const { data: configs } = await supabase.from('sensor_configs').select('*').in('mac', macs);
    if (!configs) return;

    const potenciaisAlertas = [];
    leituras.forEach(l => {
        const conf = configs.find(c => c.mac === l.mac);
        if (!conf) return;

        let sev = null;
        if (conf.temp_max && l.temp > conf.temp_max) sev = classificarSeveridade('Temperatura', l.temp, conf.temp_max);
        
        if (sev) {
            potenciaisAlertas.push({
                sensor_mac: l.mac, gateway_mac: l.gw, alert_type: `Temperatura [${sev}]`,
                read_value: l.temp, limit_value: conf.temp_max, display_name: conf.display_name
            });
        }
    });

    if (potenciaisAlertas.length > 0) {
        await supabase.from('critical_logs').insert(potenciaisAlertas);
        logger.warn(`⚠️ ${potenciaisAlertas.length} alertas gerados.`);
    }
};

// --- TAREFA AGENDADA (N8N) ---
cron.schedule('*/30 * * * *', async () => {
    if (!ENABLE_ALERTS) return;
    logger.info('📅 Gerando resumo de alertas para N8N...');
    // Lógica de consulta e envio MQTT (TOPIC_ALERTS)...
});

// --- PROCESSAMENTO MQTT ---
client.on('connect', () => logger.info(`✅ MQTT Conectado. Assinando ${TOPIC_DATA}`));

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

                    // 1. FILTRO DE PORTAS
                    if (PROCESS_DOORS && sensor.alarm !== undefined) {
                        const isOpen = sensor.alarm > 0;
                        if (isOpen !== last.state || timeDiff > DOOR_DEBOUNCE_MS) {
                            batchPortas.push({
                                gateway_mac: gwMac, sensor_mac: sensorMac,
                                timestamp_read: new Date().toISOString(),
                                battery_percent: vbatt, is_open: isOpen, alarm_code: sensor.alarm,
                                rssi: sensor.rssi
                            });
                            lastReadings.set(sensorMac, { ...last, state: isOpen, ts: now });
                        }
                    } 
                    
                    // 2. FILTRO DE TELEMETRIA (Deadband: 0.5°C / 1%)
                    else if (PROCESS_GPS && (sensor.temp !== undefined)) {
                        const diffTemp = Math.abs(sensor.temp - last.temp);
                        const diffHum = Math.abs((sensor.humidity || 0) - last.hum);

                        if (diffTemp >= VAR_TEMP_MIN || diffHum >= VAR_HUM_MIN || timeDiff > ANALOG_MAX_AGE_MS) {
                            batchTelemetria.push({
                                gw: gwMac, mac: sensorMac, ts: new Date().toISOString(),
                                batt: vbatt, temp: sensor.temp, hum: sensor.humidity,
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

        // Gravação no Banco
        if (batchPortas.length > 0) {
            const { error } = await supabase.from('door_logs').insert(batchPortas);
            if (!error) logger.info(`🚪 ${batchPortas.length} logs de porta salvos.`);
        }

        if (batchTelemetria.length > 0) {
            if (ENABLE_ALERTS) await processarAlertas(batchTelemetria);
            const { error } = await supabase.from('telemetry_logs').insert(batchTelemetria);
            if (!error) logger.info(`🌡️ ${batchTelemetria.length} logs de telemetria salvos.`);
        }

    } catch (e) {
        logger.error('❌ Erro no processamento: %s', e.message);
    }
});

app.listen(PORT, () => logger.info(`🚀 API Online na porta ${PORT}`));