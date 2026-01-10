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
    const MIN_MV = 2500; // 0%   (2.5V - Bateria morta)

    // Se for maior que o máximo, trava em 100%
    if (mVolts >= MAX_MV) return 100;
    
    // Se for menor que o mínimo, trava em 0%
    if (mVolts <= MIN_MV) return 0;

    // Cálculo gradual (Regra de três / Linear)
    const porcentagem = ((mVolts - MIN_MV) / (MAX_MV - MIN_MV)) * 100;

    // Retorna arredondado (sem casas decimais)
    return Math.round(porcentagem);
};

client.on('connect', () => {
    console.log('✅ Conectado ao MQTT! Aguardando mensagens...');
    client.subscribe(TOPIC);
});

client.on('message', async (topic, message) => {
    const msgString = message.toString();

    try {
        const payload = JSON.parse(msgString);
        
        const leiturasParaSalvar = [];

        if (Array.isArray(payload)) {
            payload.forEach(batch => {
                if (Array.isArray(batch)) {
                    batch.forEach(gatewayMsg => {
                        
                        const gatewayMac = gatewayMsg.gmac;

                        console.log(`📡 Processando leituras do gateway '${gatewayMac}'`);

                        if (gatewayMsg.obj && Array.isArray(gatewayMsg.obj)) {
                            
                            gatewayMsg.obj.forEach(sensor => {
                                // FILTRO: Apenas type 1
                                if (sensor.type === 1) {
                                    
                                    leiturasParaSalvar.push({
                                        gw: formatarMac(gatewayMac),
                                        mac: formatarMac(sensor.dmac),
                                        rssi: sensor.rssi,
                                        ts: sensor.time.replace(' ', 'T'),
                                        
                                       
                                        batt: calcularBateria(sensor.vbatt), 
                                        
                                        temp: sensor.temp,
                                        hum: sensor.humidity
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }

        // --- SALVAR NO BANCO ---
        if (leiturasParaSalvar.length > 0) {
            
            const { error } = await supabase
                .from('telemetry_logs')
                .insert(leiturasParaSalvar);

            if (error) {
                console.error('❌ Erro ao salvar no Supabase:', error.message);
            } else {
                console.log(`💾 Sucesso! ${leiturasParaSalvar.length} registros inseridos.`);
            }
        }

    } catch (e) {
        console.error('❌ Erro ao processar:', e);
    }
});