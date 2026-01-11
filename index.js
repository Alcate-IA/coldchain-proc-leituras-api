import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Configurações
const BROKER_URL = 'mqtt://broker.hivemq.com';
const TOPIC = '/alcateia/gateways/beacons/prd_ble_dat';

// Inicializa Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = mqtt.connect(BROKER_URL);

// --- FUNÇÃO PARA COLOCAR MÁSCARA NO MAC ---
const formatarMac = (mac) => {
    if (!mac) return null;
    return mac.replace(/(.{2})(?=.)/g, '$1:');
};

// --- FUNÇÃO PARA CALCULAR PORCENTAGEM DA BATERIA ---
const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const MAX_MV = 3600; // 100% (3.6V)
    const MIN_MV = 2500; // 0%   (2.5V)

    if (mVolts >= MAX_MV) return 100;
    if (mVolts <= MIN_MV) return 0;

    const porcentagem = ((mVolts - MIN_MV) / (MAX_MV - MIN_MV)) * 100;
    return Math.round(porcentagem);
};

client.on('connect', () => {
    console.log('✅ Conectado ao MQTT! Aguardando mensagens...');
    client.subscribe(TOPIC);
});

client.on('message', async (topic, message) => {
    try {
        const msgString = message.toString();
        let payload = JSON.parse(msgString);

        // --- CORREÇÃO DO ANINHAMENTO (Achatando os arrays [[[[ ]]]]) ---
        // Continua achatando enquanto o primeiro elemento for um array
        while (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
            payload = payload.flat();
        }

        // Se após o flatten não for um array de objetos, forçamos a virar um array para o forEach
        const gateways = Array.isArray(payload) ? payload : [payload];
        
        const leiturasParaSalvar = [];

        gateways.forEach(gatewayMsg => {
            const gatewayMac = gatewayMsg.gmac;

            if (gatewayMac && gatewayMsg.obj && Array.isArray(gatewayMsg.obj)) {
                console.log(`📡 Processando gateway: ${gatewayMac}`);

                gatewayMsg.obj.forEach(sensor => {
                    // FILTRO: Apenas type 1 (Sensores de Telemetria)
                    if (sensor.type === 1) {
                        leiturasParaSalvar.push({
                            gw: formatarMac(gatewayMac),
                            mac: formatarMac(sensor.dmac),
                            rssi: sensor.rssi,
                            // Converte "2026-01-09 16:26:08.589" para ISO "2026-01-09T16:26:08.589"
                            ts: sensor.time ? sensor.time.replace(' ', 'T') : new Date().toISOString(),
                            batt: calcularBateria(sensor.vbatt),
                            temp: sensor.temp,
                            hum: sensor.humidity
                        });
                    }
                });
            }
        });

        // --- SALVAR NO BANCO ---
        if (leiturasParaSalvar.length > 0) {
            const { error } = await supabase
                .from('telemetry_logs')
                .insert(leiturasParaSalvar);

            if (error) {
                console.error('❌ Erro ao salvar no Supabase:', error.message);
                console.error('Detalhes do erro:', error);
            } else {
                console.log(`💾 Sucesso! ${leiturasParaSalvar.length} registros inseridos.`);
            }
        } else {
            console.log('⚠️ Nenhuma leitura do tipo 1 encontrada no payload.');
        }

    } catch (e) {
        console.error('❌ Erro crítico ao processar mensagem:', e.message);
    }
});

client.on('error', (err) => {
    console.error('❌ Erro de conexão MQTT:', err);
});