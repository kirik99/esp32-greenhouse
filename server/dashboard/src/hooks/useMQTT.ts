import { useState, useEffect, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { MQTT_WS_URL } from '../config';

interface SensorData {
  temp?: number;
  hum?: number;
  co2?: number;
  pressure?: number;
  soil_temp?: number;
  diag?: string;
  online?: {
    temp: boolean;
    hum: boolean;
    co2: boolean;
    pressure: boolean;
    soil_temp: boolean;
  };
}

interface RelayState {
  [key: string]: boolean;
}

// The firmware reports "no data" as -999 (older builds may also send null/NaN).
// Normalise everything to undefined so the UI can show '--' instead of a fake value.
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value !== -999 ? value : undefined;
}

function ok(flag: unknown, value: number | undefined): boolean {
  return flag === undefined || flag === null ? value !== undefined : flag === true && value !== undefined;
}

export function useMQTT() {
  const [client, setClient] = useState<MqttClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [sensors, setSensors] = useState<SensorData | null>(null);
  const [relays, setRelays] = useState<RelayState>({
    1: false, 2: false, 3: false, 4: false, 5: false, 6: false
  });

  useEffect(() => {
    const mqttClient = mqtt.connect(MQTT_WS_URL);

    mqttClient.on('connect', () => {
      setIsConnected(true);
      mqttClient.subscribe('growbox/sensors');
      mqttClient.subscribe('growbox/status');
    });

    mqttClient.on('disconnect', () => {
      setIsConnected(false);
    });

    mqttClient.on('offline', () => {
      setIsConnected(false);
    });

    mqttClient.on('error', (err) => {
      console.error('MQTT Error:', err);
      setIsConnected(false);
    });

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (topic === 'growbox/sensors') {
          const temp = num(payload.air_temp ?? payload.temp);
          const hum = num(payload.humidity ?? payload.hum);
          const co2 = num(payload.co2_ppm ?? payload.co2);
          const pressure = num(payload.pressure);
          const soil_temp = num(payload.substrate_temp ?? payload.soil_temp);

          setSensors({
            temp,
            hum,
            co2,
            pressure,
            soil_temp,
            diag: typeof payload.diag === 'string' ? payload.diag : undefined,
            online: {
              temp: ok(payload.air_temp_ok, temp),
              hum: ok(payload.humidity_ok, hum),
              co2: ok(payload.co2_ok, co2),
              pressure: ok(payload.pressure_ok, pressure),
              soil_temp: ok(payload.substrate_temp_ok, soil_temp),
            },
          });
        } else if (topic === 'growbox/status') {
          if (Array.isArray(payload.relays)) {
            const map: RelayState = {};
            payload.relays.forEach((state: boolean, i: number) => {
              map[i + 1] = state;
            });
            setRelays(map);
          } else if (payload.relays && typeof payload.relays === 'object') {
            setRelays(payload.relays);
          }
        }
      } catch (e) {
        console.error('Failed to parse MQTT message:', e);
      }
    });

    setClient(mqttClient);

    return () => {
      mqttClient.end();
    };
  }, []);

  const setRelay = useCallback((relay: number, state: boolean) => {
    if (client && isConnected) {
      client.publish('growbox/relay/set', JSON.stringify({ relay, state }));
      // Optimistic update
      setRelays(prev => ({ ...prev, [relay]: state }));
    }
  }, [client, isConnected]);

  return { isConnected, sensors, relays, setRelay };
}
