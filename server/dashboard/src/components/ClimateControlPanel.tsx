import React, { useState, useEffect } from 'react';
import { Sparkles, Wind, Moon, Sun, Flame, Droplets, ShieldCheck, Activity } from 'lucide-react';

interface Profile {
  id: string;
  name: string;
  description: string;
  controlTempBy: string;
  tempTarget?: number;
  tempOn?: number;
  tempOff?: number;
  humTarget?: number;
  humOn?: number;
  humOff?: number;
  co2Max?: number;
  lightMode?: string;
  faeIntervalMin?: number;
  faeDurationSec?: number;
}

interface ClimateState {
  mode: string;
  modeName: string;
  substate: string;
  safetyAlert: string | null;
  activeProfile: Profile;
  timers: {
    mistLockRemainingSec: number;
    heaterCooldownRemainingSec: number;
    nextFaeInSec: number;
    isPurgingCo2: boolean;
  };
}

export function ClimateControlPanel() {
  const [climate, setClimate] = useState<ClimateState | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchState = async () => {
    try {
      const res = await fetch('/api/climate');
      if (res.ok) {
        const data = await res.json();
        setClimate(data);
      }
    } catch (e) {
      console.warn('Failed to fetch climate state:', e);
    }
  };

  useEffect(() => {
    fetchState();
    const timer = setInterval(fetchState, 5000);
    return () => clearInterval(timer);
  }, []);

  const switchMode = async (mode: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/climate/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state) setClimate(data.state);
      }
    } catch (e) {
      console.error('Mode switch error:', e);
    } finally {
      setLoading(false);
    }
  };

  const getSubstateColor = (substate: string) => {
    if (substate.includes('АВАРИЯ') || substate.includes('ПЕРЕГРЕВ')) return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    if (substate.includes('Продувка') || substate.includes('FAE')) return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
    if (substate.includes('Блокировка') || substate.includes('Охлаждение')) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    return 'bg-blue-500/20 text-blue-300 border-blue-500/40';
  };

  return (
    <div className="bg-gray-800/60 backdrop-blur border border-gray-700/60 rounded-xl p-4 shadow-lg space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider">
              Режим микроклимата: Pleurotus ostreatus
            </h3>
            {climate?.substate && (
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${getSubstateColor(climate.substate)}`}>
                {climate.substate}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {climate?.activeProfile?.description || 'Интеллектуальный контроль параметров'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-gray-900/80 rounded-lg border border-gray-700/50">
          {[
            { id: 'incubation', label: 'Инкубация', icon: Moon },
            { id: 'pinning', label: 'Инициация', icon: Wind },
            { id: 'fruiting', label: 'Плодоношение', icon: Sun },
            { id: 'manual', label: 'Ручной', icon: ShieldCheck }
          ].map(m => {
            const Icon = m.icon;
            const isActive = climate?.mode === m.id;
            return (
              <button
                key={m.id}
                disabled={loading}
                onClick={() => switchMode(m.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                  isActive
                    ? 'bg-emerald-600 text-white font-semibold shadow-md'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {climate?.activeProfile && climate.mode !== 'manual' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-gray-700/50 text-xs">
          <div className="bg-gray-900/40 p-2.5 rounded-lg border border-gray-800 flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-400 flex-shrink-0" />
            <div>
              <span className="text-[10px] text-gray-400 block font-mono">
                {climate.activeProfile.controlTempBy === 'substrate' ? 'Цель субстрата' : 'Цель воздуха'}
              </span>
              <span className="text-gray-200 font-semibold font-mono">
                {climate.activeProfile.tempOn}°C — {climate.activeProfile.tempOff}°C
              </span>
            </div>
          </div>

          <div className="bg-gray-900/40 p-2.5 rounded-lg border border-gray-800 flex items-center gap-2">
            <Droplets className="w-4 h-4 text-blue-400 flex-shrink-0" />
            <div>
              <span className="text-[10px] text-gray-400 block font-mono">Влажность</span>
              <span className="text-gray-200 font-semibold font-mono">
                {climate.activeProfile.humOn}% — {climate.activeProfile.humOff}%
              </span>
            </div>
          </div>

          <div className="bg-gray-900/40 p-2.5 rounded-lg border border-gray-800 flex items-center gap-2">
            <Wind className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <div>
              <span className="text-[10px] text-gray-400 block font-mono">Порог CO₂</span>
              <span className="text-gray-200 font-semibold font-mono">
                {climate.activeProfile.co2Max ? `< ${climate.activeProfile.co2Max} ppm` : 'Не лимит.'}
              </span>
            </div>
          </div>

          <div className="bg-gray-900/40 p-2.5 rounded-lg border border-gray-800 flex items-center gap-2">
            <Activity className="w-4 h-4 text-purple-400 flex-shrink-0" />
            <div>
              <span className="text-[10px] text-gray-400 block font-mono">Таймеры</span>
              <span className="text-gray-200 font-semibold font-mono">
                {climate.timers.mistLockRemainingSec > 0
                  ? `Туман заблокир. (${climate.timers.mistLockRemainingSec}с)`
                  : climate.timers.heaterCooldownRemainingSec > 0
                  ? `ТЭН обдув (${climate.timers.heaterCooldownRemainingSec}с)`
                  : `FAE через ${Math.floor(climate.timers.nextFaeInSec / 60)}м`}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
