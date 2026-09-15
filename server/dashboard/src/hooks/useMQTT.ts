import { useState, useEffect, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { MQTT_WS_URL } from '../config';

interface SensorData {
  temp: number;
  hum: number;
  co2: number;
  pressure: number;
  soil_temp: number;
}

interface RelayState {
  [key: string]: boolean;
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
          setSensors({
            temp: payload.air_temp ?? payload.temp,
            hum: payload.humidity ?? payload.hum,
            co2: payload.co2_ppm ?? payload.co2,
            pressure: payload.pressure,
            soil_temp: payload.substrate_temp ?? payload.soil_temp,
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
