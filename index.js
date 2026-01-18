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
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        })
    ],
});

// --- CONSTANTES E CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3030;
const BROKER_URL = 'mqtt://broker.hivemq.com';

// Filtros e Deadbands para Gravação
const DOOR_DEBOUNCE_MS = 5000;      // 5 segundos para porta (para gravar no banco)
const ANALOG_MAX_AGE_MS = 300000;   // 5 minutos (heartbeat gravação)
const VAR_TEMP_MIN = 0.5;           // Variação min de Temperatura
const VAR_HUM_MIN = 1.0;            // Variação min de Umidade

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat'; 

// Feature Flags
const PROCESS_GPS    = process.env.ENABLE_GPS_DATA === 'true';    
const PROCESS_DOORS  = process.env.ENABLE_DOORS === 'true';       

// Cache de estados: { sensor_mac: { temp, hum, state, ts } }
const lastReadings = new Map();

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO MQTT (CLIENT ID ÚNICO PARA VPS)
// ---------------------------------------------------------------------------
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

// --- ROTINA: RELATÓRIO INTELIGENTE PARA AGENTE DE VOZ (VIA N8N) ---
const processarRelatorioVoz = async () => {
    logger.info('🗣️ Iniciando verificação para Agente de Voz...');

    const TEMPO_LIMITE_PORTA_MS = 5 * 60 * 1000; // 5 minutos permitidos

    // 1. Busca configurações APENAS de sensores ativos
    const { data: configs } = await supabase
        .from('sensor_configs')
        .select('*')
        .eq('em_manutencao', false);

    if (!configs || configs.length === 0) return;

    // 2. Busca logs de Telemetria (Temp/Hum)
    const { data: logsTelemetria } = await supabase
        .from('telemetry_logs')
        .select('mac, temp, hum, ts')
        .order('ts', { ascending: false })
        .limit(2000);

    // 3. Busca logs de Portas (Limite maior para rastrear histórico)
    const { data: logsPortas } = await supabase
        .from('door_logs')
        .select('sensor_mac, is_open, timestamp_read')
        .order('timestamp_read', { ascending: false })
        .limit(3000);

    // 4. Estruturação dos Dados
    // Mapa Telemetria (Apenas última leitura)
    const ultimasLeituras = new Map();
    if (logsTelemetria) {
        logsTelemetria.forEach(log => {
            if (!ultimasLeituras.has(log.mac)) ultimasLeituras.set(log.mac, log);
        });
    }

    // Mapa Portas (Array histórico por sensor)
    const historicoPortas = {};
    if (logsPortas) {
        logsPortas.forEach(log => {
            if (!historicoPortas[log.sensor_mac]) historicoPortas[log.sensor_mac] = [];
            historicoPortas[log.sensor_mac].push(log);
        });
    }

    // 5. Análise de Regras
    let frasesDeAlerta = [];
    let detalhesTecnicos = []; 

    configs.forEach(config => {
        const leitura = ultimasLeituras.get(config.mac);
        const logsDoSensor = historicoPortas[config.mac];
        
        const nomeFalado = (config.display_name || "Sensor desconhecido").replace(/_/g, " ");
        let problemasSensor = [];

        // --- A. Regra: Temperatura e Umidade ---
        if (leitura) {
            // Verifica Temperatura Máxima
            if (config.temp_max !== null && leitura.temp > config.temp_max) {
                const valor = leitura.temp.toFixed(1).replace('.', ','); 
                problemasSensor.push(`temperatura alta de ${valor} graus`);
            }
            // Verifica Umidade Máxima
            if (config.hum_max !== null && leitura.hum > config.hum_max) {
                const valor = leitura.hum.toFixed(0); 
                problemasSensor.push(`umidade alta de ${valor} por cento`);
            }
        }

        // --- B. Regra: Porta Esquecida Aberta (> 5 min) ---
        if (logsDoSensor && logsDoSensor.length > 0) {
            // log[0] é o estado atual
            const estadoAtual = logsDoSensor[0];

            if (estadoAtual.is_open === true) {
                // A porta está aberta AGORA. Vamos voltar no tempo para ver desde quando.
                let dataInicioAbertura = new Date(estadoAtual.timestamp_read);
                
                // Percorre do mais novo para o mais antigo
                for (let i = 0; i < logsDoSensor.length; i++) {
                    if (logsDoSensor[i].is_open === false) {
                        // Achamos quando ela estava fechada. Paramos.
                        break;
                    }
                    // Enquanto for true, empurramos o início para trás
                    dataInicioAbertura = new Date(logsDoSensor[i].timestamp_read);
                }

                const agora = new Date();
                const tempoAbertoMs = agora - dataInicioAbertura;

                // Se superou o limite de tolerância
                if (tempoAbertoMs > TEMPO_LIMITE_PORTA_MS) {
                    const minutos = Math.floor(tempoAbertoMs / 60000);
                    problemasSensor.push(`porta aberta há ${minutos} minutos`);
                }
            }
        }

        // --- C. Consolidação dos Alertas ---
        if (problemasSensor.length > 0) {
            // Ex: "No Câmara 1, foi detectado temperatura alta... E porta aberta..."
            frasesDeAlerta.push(`No ${nomeFalado}, foi detectado ${problemasSensor.join(' e ')}.`);
            
            detalhesTecnicos.push({
                sensor: config.display_name,
                temp: leitura ? leitura.temp : null,
                problemas: problemasSensor
            });
        }
    });

    // 6. Envio para N8N (apenas se houver alertas)
    if (frasesDeAlerta.length === 0) {
        logger.info('✅ Voz: Tudo normal (Parâmetros OK e portas fechadas/recentes).');
        return; 
    }

    const saudacao = "Olá, monitoramento da Alcateia informa.";
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
        logger.info(`📞 Enviando alerta de voz (${frasesDeAlerta.length} ocorrências) para o N8N...`);
        
        const response = await fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) logger.info('✅ Webhook N8N acionado com sucesso.');
        else logger.error(`❌ Erro no Webhook N8N: ${response.statusText}`);

    } catch (error) {
        logger.error(`❌ Falha na conexão com N8N: ${error.message}`);
    }
};

// Agenda a rotina de voz para rodar a cada 30 minutos
cron.schedule('*/30 * * * *', () => processarRelatorioVoz());

// --- EVENTOS MQTT (Gravação de Dados) ---

client.on('connect', () => {
    logger.info(`✅ [MQTT] Conectado! ID: ${client.options.clientId}`);
    
    client.subscribe(TOPIC_DATA, (err) => {
        if (!err) {
            logger.info(`📡 [MQTT] Inscrito no tópico: ${TOPIC_DATA}`);
        } else {
            logger.error(`❌ [MQTT] Erro na inscrição: ${err.message}`);
        }
    });
});

client.on('reconnect', () => logger.warn('⚠️ [MQTT] Tentando reconectar...'));
client.on('offline', () => logger.warn('🔌 [MQTT] Cliente offline.'));
client.on('error', (err) => logger.error(`🔥 [MQTT] Erro: ${err.message}`));

client.on('message', async (topic, message) => {
    if (topic !== TOPIC_DATA) return;

    try {
        const payloadStr = message.toString();
        const payload = JSON.parse(payloadStr);
        
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

                    // 1. PORTAS (Gravação em door_logs)
                    if (PROCESS_DOORS && sensor.alarm !== undefined) {
                        const isOpen = sensor.alarm > 0;
                        // Grava se mudou o estado OU se passou muito tempo (heartbeat da porta)
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
                    
                    // 2. TELEMETRIA (Gravação em telemetry_logs)
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
            const { error } = await supabase.from('telemetry_logs').insert(batchTelemetria);
            if (!error) logger.info(`🌡️ ${batchTelemetria.length} logs de telemetria salvos.`);
            else logger.error(`❌ Erro Supabase Telemetria: ${error.message}`);
        }

    } catch (e) {
        logger.error(`❌ Erro no processamento da mensagem: ${e.message}`);
    }
});

app.listen(PORT, () => logger.info(`🚀 API Online na porta ${PORT}`));