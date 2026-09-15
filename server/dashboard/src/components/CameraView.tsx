import React, { useState, useEffect, useCallback } from 'react';
import { Camera, RefreshCw, Aperture } from 'lucide-react';
import { API_BASE_URL } from '../config';

export const CameraView: React.FC = () => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [snapping, setSnapping] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLatestImage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_BASE_URL}/latest-image?t=${new Date().getTime()}`;
      const res = await fetch(url);
      
      if (!res.ok) {
        throw new Error(`Failed to fetch image: ${res.statusText}`);
      }
      
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      setImageUrl(objectUrl);
      
      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        setTimestamp(new Date(dateHeader).toLocaleString());
      } else {
        setTimestamp(new Date().toLocaleString());
      }
      
    } catch (err) {
      console.error('Error fetching image:', err);
      setError('Не удалось загрузить фото');
    } finally {
      setLoading(false);
    }
  }, []);

  const takeSnapshot = async () => {
    setSnapping(true);
    try {
      await fetch(`${API_BASE_URL}/capture`, { method: 'POST' });
      // Ждем 3.5 секунды, пока ESP32 сделает снимок, закодирует и bridge сохранит JPEG
      setTimeout(() => {
        fetchLatestImage();
        setSnapping(false);
      }, 3500);
    } catch (err) {
      console.error('Snapshot trigger failed:', err);
      setSnapping(false);
    }
  };

  useEffect(() => {
    fetchLatestImage();
    const interval = setInterval(fetchLatestImage, 60 * 1000);
    return () => {
      clearInterval(interval);
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [fetchLatestImage]);

  return (
    <div className="bg-gray-800 rounded-xl p-4 shadow-lg border border-gray-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 text-gray-200">
          <Camera size={20} className="text-blue-400" />
          Камера
        </h2>
        <div className="flex gap-2">
          <button 
            onClick={takeSnapshot}
            disabled={snapping}
            title="Сделать снимок сейчас"
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/40 rounded-lg text-xs font-semibold text-blue-300 disabled:opacity-50 transition-all"
          >
            <Aperture size={15} className={snapping ? 'animate-spin' : ''} />
            <span>{snapping ? 'Съёмка...' : 'Снимок'}</span>
          </button>
          <button 
            onClick={fetchLatestImage} 
            disabled={loading}
            title="Обновить изображение"
            className="p-2 bg-gray-700 rounded-lg hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={`text-gray-300 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      
      <div className="flex-1 bg-gray-900 rounded-lg overflow-hidden relative min-h-[200px] flex items-center justify-center border border-gray-800">
        {loading && !imageUrl ? (
          <div className="flex flex-col items-center text-gray-500">
            <RefreshCw size={32} className="animate-spin mb-2" />
            <span>Загрузка фото...</span>
          </div>
        ) : error ? (
          <div className="text-red-400 text-center p-4">
            <p>{error}</p>
          </div>
        ) : imageUrl ? (
          <img 
            src={imageUrl} 
            alt="Growbox Camera" 
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="text-gray-500">Нет фото</div>
        )}
        
        {timestamp && !error && (
          <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-sm text-xs text-white px-2 py-1 rounded">
            {timestamp}
          </div>
        )}
      </div>
    </div>
  );
};
