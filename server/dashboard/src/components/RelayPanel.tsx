import React from 'react';
import { Power } from 'lucide-react';

interface Props {
  relays: { [key: string]: boolean };
  setRelay: (relay: number, state: boolean) => void;
}

const RELAY_CONFIG = [
  { id: 1, name: 'Увлажнитель' },
  { id: 2, name: 'Нагреватель' },
  { id: 3, name: 'Вент.нагревателя' },
  { id: 4, name: 'Вентилятор 1' },
  { id: 5, name: 'Вентилятор 2' },
  { id: 6, name: 'Подсветка' },
];

export const RelayPanel: React.FC<Props> = ({ relays, setRelay }) => {
  return (
    <div className="bg-gray-800 rounded-xl p-4 shadow-lg border border-gray-700">
      <h2 className="text-lg font-semibold mb-4 text-gray-200">Управление реле</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {RELAY_CONFIG.map(({ id, name }) => {
          const isOn = relays[id] || false;
          return (
            <button
              key={id}
              onClick={() => setRelay(id, !isOn)}
              className={`flex flex-col items-center justify-center p-4 rounded-xl transition-all duration-200 ${
                isOn 
                  ? 'bg-green-600/20 border-green-500/50 hover:bg-green-600/30' 
                  : 'bg-gray-700/50 border-gray-600 hover:bg-gray-700'
              } border`}
            >
              <Power className={`mb-2 ${isOn ? 'text-green-500 shadow-green-500/50 drop-shadow-md' : 'text-gray-400'}`} size={24} />
              <span className="text-sm text-center text-gray-300 font-medium mb-1 line-clamp-1">{name}</span>
              <span className={`text-xs font-bold ${isOn ? 'text-green-400' : 'text-gray-500'}`}>
                {isOn ? 'ON' : 'OFF'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
