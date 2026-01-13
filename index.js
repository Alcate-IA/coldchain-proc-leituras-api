import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

dotenv.config();

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const BROKER_URL = 'mqtt://broker.hivemq.com';
const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat';
const TOPIC_ALERTS = '/alcateia/alerts/summary';

// Tolerâncias para evitar ruído
const TOLERANCIA_TEMP = 0.5;
const TOLERANCIA_HUM = 2.0;

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = mqtt.connect(BROKER_URL);

app.use(cors());
app.use(express.json());

// --- FUNÇÕES AUXILIARES ---
const formatarMac = (mac) => {
    if (!mac) return null;
    if (mac.includes(':')) return mac;
    return mac.replace(/(.{2})(?=.)/g, '$1:');
};

const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const MAX_MV = 3600;
    const MIN_MV = 2500;
    if (mVolts >= MAX_MV) return 100;
    if (mVolts <= MIN_MV) return 0;
    return Math.round(((mVolts - MIN_MV) / (MAX_MV - MIN_MV)) * 100);
};

// Classificação de Severidade
const classificarSeveridade = (tipo, valor, limite) => {
    let delta = 0;
    if (tipo === 'Temperatura') {
        delta = valor - limite;
        if (delta <= TOLERANCIA_TEMP) return null;
        if (delta < 2.0) return 'LEVE';
        if (delta < 5.0) return 'MEDIA';
        return 'URGENTE';
    }
    if (tipo === 'Umidade') {
        delta = valor - limite;
        if (delta <= TOLERANCIA_HUM) return null;
        if (delta < 10) return 'LEVE';
        if (delta < 20) return 'MEDIA';
        return 'URGENTE';
    }
    if (tipo === 'Bateria') {
        if (valor > limite) return null;
        if (valor < 5) return 'URGENTE';
        if (valor < 10) return 'MEDIA';
        return 'LEVE';
    }
    return 'LEVE';
};

// --- FUNÇÃO: PROCESSAR E SALVAR NO BANCO ---
const processarAlertas = async (leituras) => {
    if (leituras.length === 0) return;
    
    const macs = [...new Set(leituras.map(l => l.mac))];
    
    const { data: configs, error } = await supabase
        .from('sensor_configs')
        .select('mac, display_name, temp_max, hum_max, batt_warning')
        .in('mac', macs);

    if (error || !configs || configs.length === 0) return;

    const configMap = new Map(configs.map(c => [c.mac, c]));
    const potenciaisAlertas = [];

    leituras.forEach(leitura => {
        const config = configMap.get(leitura.mac);
        if (!config) return;

        let severidade = null;
        let tipoAlerta = '';
        let limite = 0;
        let valor = 0;

        if (config.temp_max !== null && leitura.temp > config.temp_max) {
            severidade = classificarSeveridade('Temperatura', leitura.temp, config.temp_max);
            tipoAlerta = 'Temperatura';
            limite = config.temp_max;
            valor = leitura.temp;
        }
        else if (config.hum_max !== null && leitura.hum > config.hum_max) {
            severidade = classificarSeveridade('Umidade', leitura.hum, config.hum_max);
            tipoAlerta = 'Umidade';
            limite = config.hum_max;
            valor = leitura.hum;
        }
        else if (config.batt_warning !== null && leitura.batt < config.batt_warning) {
            severidade = classificarSeveridade('Bateria', leitura.batt, config.batt_warning);
            tipoAlerta = 'Bateria';
            limite = config.batt_warning;
            valor = leitura.batt;
        }

        if (severidade) {
            potenciaisAlertas.push({
                sensor_mac: leitura.mac,
                gateway_mac: leitura.gw,
                display_name: config.display_name,
                alert_type: `${tipoAlerta} [${severidade}]`,
                read_value: valor,
                limit_value: limite
            });
        }
    });

    if (potenciaisAlertas.length === 0) return;

    const macsComAlerta = [...new Set(potenciaisAlertas.map(a => a.sensor_mac))];
    const { data: logsExistentes } = await supabase
        .from('critical_logs')
        .select('sensor_mac, alert_type, read_value')
        .eq('processed', false)
        .in('sensor_mac', macsComAlerta);

    const alertasParaSalvar = potenciaisAlertas.filter(novo => {
        const duplicado = logsExistentes?.some(existente => 
            existente.sensor_mac === novo.sensor_mac &&
            existente.alert_type === novo.alert_type &&
            existente.read_value === novo.read_value
        );
        return !duplicado;
    });

    if (alertasParaSalvar.length > 0) {
        await supabase.from('critical_logs').insert(alertasParaSalvar);
    }
};

// --- FUNÇÃO: GERAR JSON ESTRUTURADO PARA AUTOMAÇÃO ---
const gerarResumoAlertas = async () => {
    console.log('📅 Gerando payload JSON estruturado...');
    
    const agora = new Date();
    // Busca alertas não processados dos últimos 40 min
    const janelaTempo = new Date(agora.getTime() - 40 * 60 * 1000); 

    const { data: logs, error } = await supabase
        .from('critical_logs')
        .select('*')
        .eq('processed', false)
        .gte('created_at', janelaTempo.toISOString());

    if (error || !logs || logs.length === 0) return;

    // 1. Agrupamento e Estatísticas
    const grupos = { LEVE: [], MEDIA: [], URGENTE: [] };
    let totalTemp = 0, totalHum = 0, totalBatt = 0;

    logs.forEach(log => {
        // Stats
        if (log.alert_type.includes('Temperatura')) totalTemp++;
        else if (log.alert_type.includes('Umidade')) totalHum++;
        else if (log.alert_type.includes('Bateria')) totalBatt++;

        // Categorização
        let severidade = 'LEVE';
        if (log.alert_type.includes('[URGENTE]')) severidade = 'URGENTE';
        else if (log.alert_type.includes('[MEDIA]')) severidade = 'MEDIA';
        
        // Estrutura Limpa
        grupos[severidade].push({
            sensor: log.display_name || log.sensor_mac,
            mac: log.sensor_mac,
            problema: log.alert_type.split(' [')[0], // Remove a tag [MEDIA]
            valor_lido: Number(log.read_value),
            valor_limite: Number(log.limit_value),
            horario: log.created_at
        });
    });

    // 2. Definição de Estratégias (Flags para o n8n rotear)
    const strategies = {
        urgente: {
            has_alerts: grupos.URGENTE.length > 0,
            count: grupos.URGENTE.length,
            suggested_channel: "LIGACAO_VOZ"
        },
        media: {
            has_alerts: grupos.MEDIA.length > 0,
            count: grupos.MEDIA.length,
            suggested_channel: "WHATSAPP"
        },
        leve: {
            has_alerts: grupos.LEVE.length > 0,
            count: grupos.LEVE.length,
            suggested_channel: "LOG_OU_WHATSAPP"
        }
    };

    // 3. Montagem do Payload Final
    const payloadN8N = {
        meta: {
            timestamp: agora.toISOString(),
            source: "Alcateia IoT Backend",
            total_alerts: logs.length
        },
        strategies: strategies,
        stats: {
            temp_count: totalTemp,
            hum_count: totalHum,
            batt_count: totalBatt
        },
        details: {
            urgente: grupos.URGENTE,
            media: grupos.MEDIA,
            leve: grupos.LEVE
        }
    };

    // 4. Publica e Atualiza
    client.publish(TOPIC_ALERTS, JSON.stringify(payloadN8N), { qos: 1, retain: false });
    console.log(`📢 JSON enviado para ${TOPIC_ALERTS} (Total: ${logs.length})`);

    const ids = logs.map(l => l.id);
    await supabase.from('critical_logs').update({ processed: true }).in('id', ids);
};

// Cron a cada 1 min
cron.schedule('*/1 * * * *', () => gerarResumoAlertas());

// MQTT Listen
client.on('connect', () => {
    console.log('✅ Conectado ao MQTT!');
    client.subscribe(TOPIC_DATA);
});

client.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        let leituras = [];

        if (payload.gw) {
            leituras.push({ 
                gw: formatarMac(payload.gw), mac: formatarMac(payload.mac), 
                ts: payload.ts, batt: payload.batt, 
                temp: payload.temp, hum: payload.hum, rssi: payload.rssi 
            });
        } else {
            // Suporte legado
            const raw = Array.isArray(payload) ? payload.flat(Infinity) : [payload];
            raw.forEach(gw => {
                if (gw.obj) gw.obj.filter(s => s.type === 1).forEach(s => {
                    leituras.push({
                        gw: formatarMac(gw.gmac),
                        mac: formatarMac(s.dmac),
                        ts: s.time ? s.time.replace(' ', 'T') : new Date().toISOString(),
                        batt: calcularBateria(s.vbatt),
                        temp: s.temp, hum: s.humidity, rssi: s.rssi
                    });
                });
            });
        }

        if (leituras.length > 0) {
            await processarAlertas(leituras);
            await supabase.from('telemetry_logs').insert(leituras);
        }
    } catch (e) {
        console.error('Erro msg:', e.message);
    }
});

app.get('/api/telemetry/latest', async (req, res) => {
    const { data } = await supabase.from('last_sensor_readings').select('*');
    res.json(data);
});

app.listen(PORT, () => console.log(`🚀 API: ${PORT}`));