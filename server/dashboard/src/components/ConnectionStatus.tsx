import React from 'react';
import { Wifi, WifiOff } from 'lucide-react';

interface Props {
  isConnected: boolean;
}

export const ConnectionStatus: React.FC<Props> = ({ isConnected }) => {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'} shadow-[0_0_8px_currentColor]`} />
      <span className="text-sm font-medium text-gray-300">
        {isConnected ? 'Connected' : 'Disconnected'}
      </span>
      {isConnected ? (
        <Wifi size={16} className="text-green-500" />
      ) : (
        <WifiOff size={16} className="text-red-500" />
      )}
    </div>
  );
};
