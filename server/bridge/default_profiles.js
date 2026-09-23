const DEFAULT_PROFILES = [
  {
    id: 'pleurotus_ostreatus',
    name: 'Вешенка обыкновенная',
    species: 'Pleurotus ostreatus',
    stages: [
      {
        id: 'stage_1',
        name: 'Колонизация',
        order: 1,
        duration_days: 14,
        temp: { target: 24, min: 20, max: 28, heater_on: 23.5, heater_off: 24.5 },
        substrate_temp: { target: 25, min: 22, max: 29 },
        humidity: { target: 80, min: 70, max: 90, humidifier_on: 75, humidifier_off: 85 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_2',
        name: 'Примордии',
        order: 2,
        duration_days: 7,
        temp: { target: 15.5, min: 13, max: 20, heater_on: 14.5, heater_off: 16.5 },
        substrate_temp: { target: 16, min: 13, max: 22 },
        humidity: { target: 95, min: 90, max: 98, humidifier_on: 92, humidifier_off: 96 },
        co2: { target: 750, max: 950, fan_on: 850, fan_off: 750, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '09:00', off_time: '19:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_3',
        name: 'Плодоношение',
        order: 3,
        duration_days: 7,
        temp: { target: 18, min: 15, max: 22, heater_on: 17, heater_off: 19 },
        substrate_temp: { target: 18, min: 15, max: 22 },
        humidity: { target: 88, min: 80, max: 92, humidifier_on: 85, humidifier_off: 90 },
        co2: { target: 800, max: 1000, fan_on: 900, fan_off: 800, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      }
    ]
  },
  {
    id: 'pleurotus_eryngii',
    name: 'Королевская вешенка / Еринги',
    species: 'Pleurotus eryngii',
    stages: [
      {
        id: 'stage_1',
        name: 'Колонизация',
        order: 1,
        duration_days: 14,
        temp: { target: 24, min: 20, max: 28, heater_on: 23.5, heater_off: 24.5 },
        substrate_temp: { target: 25, min: 22, max: 29 },
        humidity: { target: 80, min: 70, max: 90, humidifier_on: 75, humidifier_off: 85 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_2',
        name: 'Формирование ножки',
        order: 2,
        duration_days: 7,
        temp: { target: 15.5, min: 13, max: 20, heater_on: 14.5, heater_off: 16.5 },
        substrate_temp: { target: 16, min: 13, max: 22 },
        humidity: { target: 95, min: 90, max: 98, humidifier_on: 92, humidifier_off: 96 },
        co2: { target: 750, max: 950, fan_on: 850, fan_off: 750, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '09:00', off_time: '19:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_3',
        name: 'Плодоношение',
        order: 3,
        duration_days: 7,
        temp: { target: 18, min: 15, max: 22, heater_on: 17, heater_off: 19 },
        substrate_temp: { target: 18, min: 15, max: 22 },
        humidity: { target: 88, min: 80, max: 92, humidifier_on: 85, humidifier_off: 90 },
        co2: { target: 800, max: 1000, fan_on: 900, fan_off: 800, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      }
    ]
  },
  {
    id: 'hericium_erinaceus',
    name: 'Ежовик гребенчатый',
    species: 'Hericium erinaceus',
    stages: [
      {
        id: 'stage_1',
        name: 'Колонизация',
        order: 1,
        duration_days: 14,
        temp: { target: 24, min: 20, max: 28, heater_on: 23.5, heater_off: 24.5 },
        substrate_temp: { target: 25, min: 22, max: 29 },
        humidity: { target: 80, min: 70, max: 90, humidifier_on: 75, humidifier_off: 85 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_2',
        name: 'Примордии',
        order: 2,
        duration_days: 7,
        temp: { target: 15.5, min: 13, max: 20, heater_on: 14.5, heater_off: 16.5 },
        substrate_temp: { target: 16, min: 13, max: 22 },
        humidity: { target: 95, min: 90, max: 98, humidifier_on: 92, humidifier_off: 96 },
        co2: { target: 750, max: 950, fan_on: 850, fan_off: 750, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '09:00', off_time: '19:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_3',
        name: 'Плодоношение',
        order: 3,
        duration_days: 14,
        temp: { target: 18, min: 15, max: 22, heater_on: 17, heater_off: 19 },
        substrate_temp: { target: 18, min: 15, max: 22 },
        humidity: { target: 88, min: 80, max: 92, humidifier_on: 85, humidifier_off: 90 },
        co2: { target: 800, max: 1000, fan_on: 900, fan_off: 800, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      }
    ]
  },
  {
    id: 'lentinula_edodes',
    name: 'Шиитаке',
    species: 'Lentinula edodes',
    stages: [
      {
        id: 'stage_1',
        name: 'Колонизация',
        order: 1,
        duration_days: 14,
        temp: { target: 24, min: 20, max: 28, heater_on: 23.5, heater_off: 24.5 },
        substrate_temp: { target: 25, min: 22, max: 29 },
        humidity: { target: 80, min: 70, max: 90, humidifier_on: 75, humidifier_off: 85 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_2',
        name: 'Побурение мицелия',
        order: 2,
        duration_days: 14,
        temp: { target: 20, min: 18, max: 24, heater_on: 19.5, heater_off: 20.5 },
        substrate_temp: { target: 21, min: 18, max: 25 },
        humidity: { target: 85, min: 80, max: 90, humidifier_on: 82, humidifier_off: 88 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_3',
        name: 'Холодный шок',
        order: 3,
        duration_days: 7,
        temp: { target: 15.5, min: 13, max: 20, heater_on: 14.5, heater_off: 16.5 },
        substrate_temp: { target: 16, min: 13, max: 22 },
        humidity: { target: 95, min: 90, max: 98, humidifier_on: 92, humidifier_off: 96 },
        co2: { target: 750, max: 950, fan_on: 850, fan_off: 750, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '09:00', off_time: '19:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_4',
        name: 'Плодоношение',
        order: 4,
        duration_days: 14,
        temp: { target: 18, min: 15, max: 22, heater_on: 17, heater_off: 19 },
        substrate_temp: { target: 18, min: 15, max: 22 },
        humidity: { target: 88, min: 80, max: 92, humidifier_on: 85, humidifier_off: 90 },
        co2: { target: 800, max: 1000, fan_on: 900, fan_off: 800, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: true, schedule: true, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      }
    ]
  },
  {
    id: 'agaricus_bisporus',
    name: 'Шампиньон двуспоровый',
    species: 'Agaricus bisporus',
    stages: [
      {
        id: 'stage_1',
        name: 'Колонизация компоста',
        order: 1,
        duration_days: 14,
        temp: { target: 24, min: 20, max: 28, heater_on: 23.5, heater_off: 24.5 },
        substrate_temp: { target: 25, min: 22, max: 29 },
        humidity: { target: 80, min: 70, max: 90, humidifier_on: 75, humidifier_off: 85 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_2',
        name: 'Нанесение покровки',
        order: 2,
        duration_days: 7,
        temp: { target: 22, min: 18, max: 25, heater_on: 21.5, heater_off: 22.5 },
        substrate_temp: { target: 23, min: 18, max: 26 },
        humidity: { target: 90, min: 85, max: 95, humidifier_on: 88, humidifier_off: 92 },
        co2: { target: 2000, max: 2500, fan_on: 2200, fan_off: 2000, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 180, duration_sec: 45, fan: 4, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_3',
        name: 'Завязывание',
        order: 3,
        duration_days: 7,
        temp: { target: 15.5, min: 13, max: 20, heater_on: 14.5, heater_off: 16.5 },
        substrate_temp: { target: 16, min: 13, max: 22 },
        humidity: { target: 95, min: 90, max: 98, humidifier_on: 92, humidifier_off: 96 },
        co2: { target: 750, max: 950, fan_on: 850, fan_off: 750, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      },
      {
        id: 'stage_4',
        name: 'Плодоношение',
        order: 4,
        duration_days: 14,
        temp: { target: 18, min: 15, max: 22, heater_on: 17, heater_off: 19 },
        substrate_temp: { target: 18, min: 15, max: 22 },
        humidity: { target: 88, min: 80, max: 92, humidifier_on: 85, humidifier_off: 90 },
        co2: { target: 800, max: 1000, fan_on: 900, fan_off: 800, max_purge_sec: 300 },
        fae: { enabled: true, interval_min: 20, duration_sec: 45, fan: 5, pre_lock_sec: 0, post_lock_sec: 90 },
        light: { enabled: false, schedule: false, on_time: '08:00', off_time: '20:00' },
        camera: { enabled: true, interval_min: 60 },
        camera_light: { enabled: true, pre_delay_sec: 2, post_delay_sec: 2 }
      }
    ]
  }
];

module.exports = DEFAULT_PROFILES;
