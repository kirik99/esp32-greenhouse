import React from 'react';
import { Thermometer, Droplets, Wind, Gauge, ThermometerSun, Leaf } from 'lucide-react';
import { useMQTT } from './hooks/useMQTT';
import { ConnectionStatus } from './components/ConnectionStatus';
import { SensorCard } from './components/SensorCard';
import { RelayPanel } from './components/RelayPanel';
import { CameraView } from './components/CameraView';

function App() {
  const { isConnected, sensors, relays, setRelay } = useMQTT();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 md:p-6 lg:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center pb-4 border-b border-gray-800 gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-green-500/20 p-2 rounded-lg text-green-400">
              <Leaf size={28} />
            </div>
            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-green-400 to-emerald-300">
              Growbox Control
            </h1>
          </div>
          <ConnectionStatus isConnected={isConnected} />
        </header>

        {!isConnected && (
          <div className="bg-red-900/40 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg flex items-center gap-3">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_#ef4444]" />
            <p className="text-sm font-medium">Нет подключения к MQTT. Данные могут быть неактуальными.</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-4">
            <h2 className="text-xl font-semibold text-gray-200 flex items-center gap-2">
              <Gauge size={20} className="text-blue-400" />
              Датчики
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <SensorCard 
                title="Температура" 
                value={sensors?.temp} 
                unit="°C" 
                icon={Thermometer} 
                colorClass="text-orange-400" 
              />
              <SensorCard 
                title="Влажность" 
                value={sensors?.hum} 
                unit="%" 
                icon={Droplets} 
                colorClass="text-blue-400" 
              />
              <SensorCard 
                title="CO2" 
                value={sensors?.co2} 
                unit="ppm" 
                icon={Wind} 
                colorClass="text-emerald-400" 
              />
              <SensorCard 
                title="Давление" 
                value={sensors?.pressure} 
                unit="hPa" 
                icon={Gauge} 
                colorClass="text-purple-400" 
              />
              <SensorCard 
                title="Темп. субстрата" 
                value={sensors?.soil_temp} 
                unit="°C" 
                icon={ThermometerSun} 
                colorClass="text-amber-500" 
              />
            </div>

            <div className="pt-4">
              <RelayPanel relays={relays} setRelay={setRelay} />
            </div>
          </div>

          <div className="lg:col-span-4 h-full">
            <CameraView />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
