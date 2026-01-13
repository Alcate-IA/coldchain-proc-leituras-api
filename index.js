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

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = mqtt.connect(BROKER_URL);

// --- MIDDLEWARES ---
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

// --- FUNÇÃO: VERIFICAÇÃO DE ALERTAS (COM FILTRO DE DUPLICIDADE) ---
const processarAlertas = async (leituras) => {
    if (leituras.length === 0) return;
    
    const macs = [...new Set(leituras.map(l => l.mac))];
    
    // 1. Busca configurações
    const { data: configs, error } = await supabase
        .from('sensor_configs')
        .select('mac, display_name, temp_max, hum_max, batt_warning')
        .in('mac', macs);

    if (error || !configs || configs.length === 0) return;

    const configMap = new Map(configs.map(c => [c.mac, c]));
    const potenciaisAlertas = [];

    // 2. Identifica violações de regras
    leituras.forEach(leitura => {
        const config = configMap.get(leitura.mac);
        if (!config) return;

        if (config.temp_max !== null && leitura.temp > config.temp_max) {
            potenciaisAlertas.push({ sensor_mac: leitura.mac, gateway_mac: leitura.gw, display_name: config.display_name, alert_type: 'Temperatura', read_value: leitura.temp, limit_value: config.temp_max });
        }
        if (config.hum_max !== null && leitura.hum > config.hum_max) {
            potenciaisAlertas.push({ sensor_mac: leitura.mac, gateway_mac: leitura.gw, display_name: config.display_name, alert_type: 'Umidade', read_value: leitura.hum, limit_value: config.hum_max });
        }
        if (config.batt_warning !== null && leitura.batt < config.batt_warning) {
            potenciaisAlertas.push({ sensor_mac: leitura.mac, gateway_mac: leitura.gw, display_name: config.display_name, alert_type: 'Bateria', read_value: leitura.batt, limit_value: config.batt_warning });
        }
    });

    if (potenciaisAlertas.length === 0) return;

    // 3. Verifica duplicidade no banco (Evitar spam do mesmo valor)
    // Busca logs ativos (não processados) para esses sensores
    const macsComAlerta = [...new Set(potenciaisAlertas.map(a => a.sensor_mac))];
    
    const { data: logsExistentes, error: errLogs } = await supabase
        .from('critical_logs')
        .select('sensor_mac, alert_type, read_value')
        .eq('processed', false)
        .in('sensor_mac', macsComAlerta);

    if (errLogs) {
        console.error('❌ Erro ao verificar duplicidade:', errLogs.message);
        return; // Em caso de erro, aborta para segurança
    }

    // Filtra: Só mantém o alerta se NÃO existir um idêntico (mesmo MAC, Tipo e Valor) no banco
    const alertasParaSalvar = potenciaisAlertas.filter(novoAlerta => {
        const duplicado = logsExistentes.some(existente => 
            existente.sensor_mac === novoAlerta.sensor_mac &&
            existente.alert_type === novoAlerta.alert_type &&
            existente.read_value === novoAlerta.read_value
        );
        return !duplicado;
    });

    // 4. Salva apenas os novos
    if (alertasParaSalvar.length > 0) {
        const { error: errInsert } = await supabase.from('critical_logs').insert(alertasParaSalvar);
        if (errInsert) console.error('❌ Erro ao inserir alertas:', errInsert.message);
    }
};

// --- LÓGICA: RESUMO E ATUALIZAÇÃO ---
const gerarResumoAlertas = async () => {
    console.log('📅 Iniciando geração de relatório de alertas...');
    
    const agora = new Date();
    const janelaTempo = new Date(agora.getTime() - 40 * 60 * 1000); 

    const { data: logs, error } = await supabase
        .from('critical_logs')
        .select('*')
        .eq('processed', false)
        .gte('created_at', janelaTempo.toISOString());

    if (error) {
        console.error('❌ Erro ao buscar logs:', error.message);
        return;
    }

    if (!logs || logs.length === 0) return; // Silencioso se não houver nada

    let contagemTemp = 0;
    let contagemHum = 0;
    let contagemBatt = 0;
    const detalheSensores = {};

    logs.forEach(log => {
        const mac = log.sensor_mac;
        if (!detalheSensores[mac]) {
            detalheSensores[mac] = {
                name: log.display_name || mac,
                tempVals: [], humVals: [], battVals: [], limits: {}
            };
        }

        if (log.alert_type === 'Temperatura') {
            contagemTemp++;
            detalheSensores[mac].tempVals.push(log.read_value);
            detalheSensores[mac].limits.temp = log.limit_value;
        } 
        else if (log.alert_type === 'Umidade') {
            contagemHum++;
            detalheSensores[mac].humVals.push(log.read_value);
            detalheSensores[mac].limits.hum = log.limit_value;
        } 
        else if (log.alert_type === 'Bateria') {
            contagemBatt++;
            detalheSensores[mac].battVals.push(log.read_value);
            detalheSensores[mac].limits.batt = log.limit_value;
        }
    });

    let textoDetalhesSensores = "";
    Object.values(detalheSensores).forEach(sensor => {
        textoDetalhesSensores += `   🔸 ${sensor.name}:\n`;
        if (sensor.tempVals.length > 0) textoDetalhesSensores += `      🔥 Temp: atingiu ${Math.max(...sensor.tempVals)}°C (Limite: ${sensor.limits.temp})\n`;
        if (sensor.humVals.length > 0) textoDetalhesSensores += `      💧 Umid: atingiu ${Math.max(...sensor.humVals)}% (Limite: ${sensor.limits.hum})\n`;
        if (sensor.battVals.length > 0) textoDetalhesSensores += `      🪫 Batt: caiu para ${Math.min(...sensor.battVals)}% (Alerta em: ${sensor.limits.batt})\n`;
    });

    const header = `🚨 RELATÓRIO DE ALERTAS CRÍTICOS 🚨`;
    const resumoNumerico = `
📊 Novos Incidentes:
   🔥 Temp: ${contagemTemp} | 💧 Umid: ${contagemHum} | 🪫 Batt: ${contagemBatt}
   🔴 Total: ${logs.length}`;
    
    const secaoDetalhes = `\n📍 Detalhamento:\n${textoDetalhesSensores}`;
    const mensagemFinal = `${header}\n${resumoNumerico}\n${secaoDetalhes}`;

    client.publish(TOPIC_ALERTS, mensagemFinal, { qos: 1, retain: false });

    // Atualiza status para processado
    const idsParaAtualizar = logs.map(log => log.id);
    const { error: errUpdate } = await supabase
        .from('critical_logs')
        .update({ processed: true })
        .in('id', idsParaAtualizar);

    if (errUpdate) console.error('❌ Erro update logs:', errUpdate.message);
};

// --- AGENDAMENTO CRON (A CADA 1 MINUTO) ---
cron.schedule('*/1 * * * *', () => {
    gerarResumoAlertas();
});

// --- MQTT ---
client.on('connect', () => {
    console.log('✅ Conectado ao MQTT!');
    client.subscribe(TOPIC_DATA);
});

client.on('message', async (topic, message) => {
    try {
        const msgString = message.toString();
        let payload = JSON.parse(msgString);
        let leiturasParaSalvar = [];

        if (payload.gw && payload.mac && payload.ts) {
            leiturasParaSalvar.push({
                gw: formatarMac(payload.gw),
                mac: formatarMac(payload.mac),
                rssi: payload.rssi,
                ts: payload.ts,
                batt: payload.batt,
                temp: payload.temp,
                hum: payload.hum
            });
        } else {
             while (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
                payload = payload.flat();
            }
            const gateways = Array.isArray(payload) ? payload : [payload];
            gateways.forEach(gatewayMsg => {
                const gatewayMac = gatewayMsg.gmac;
                if (gatewayMac && gatewayMsg.obj && Array.isArray(gatewayMsg.obj)) {
                    gatewayMsg.obj.forEach(sensor => {
                        if (sensor.type === 1) {
                            leiturasParaSalvar.push({
                                gw: formatarMac(gatewayMac),
                                mac: formatarMac(sensor.dmac),
                                rssi: sensor.rssi,
                                ts: sensor.time ? sensor.time.replace(' ', 'T') : new Date().toISOString(),
                                batt: calcularBateria(sensor.vbatt),
                                temp: sensor.temp,
                                hum: sensor.humidity
                            });
                        }
                    });
                }
            });
        }

        if (leiturasParaSalvar.length > 0) {
            // Processa alertas primeiro (com verificação de duplicidade)
            await processarAlertas(leiturasParaSalvar);
            
            // Salva log de telemetria geral
            const { error } = await supabase.from('telemetry_logs').insert(leiturasParaSalvar);
            if (error) console.error('❌ Erro Supabase:', error.message);
        }
    } catch (e) {
        console.error('❌ Erro crítico:', e.message);
    }
});

app.get('/api/telemetry/latest', async (req, res) => {
    try {
        const { data, error } = await supabase.from('last_sensor_readings').select('*');
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dados' });
    }
});

app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));