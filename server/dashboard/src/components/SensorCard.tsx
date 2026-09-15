import React from 'react';
import { LucideIcon } from 'lucide-react';

interface Props {
  title: string;
  value: number | undefined;
  unit: string;
  icon: LucideIcon;
  colorClass: string;
}

export const SensorCard: React.FC<Props> = ({ title, value, unit, icon: Icon, colorClass }) => {
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex flex-col justify-between shadow-lg border border-gray-700">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-gray-400 text-sm font-medium">{title}</h3>
        <Icon className={colorClass} size={20} />
      </div>
      <div className="flex items-baseline gap-1">
        {value !== undefined ? (
          <>
            <span className="text-2xl font-bold text-gray-100">{value.toFixed(1)}</span>
            <span className="text-gray-400 text-sm">{unit}</span>
          </>
        ) : (
          <div className="h-8 w-16 bg-gray-700 animate-pulse rounded-md" />
        )}
      </div>
    </div>
  );
};
