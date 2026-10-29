const DEFAULT_PROFILES = require('../default_profiles');

describe('Default Profiles CO2 Validation', () => {
  test('There are exactly 5 species profiles', () => {
    expect(DEFAULT_PROFILES.length).toBe(5);
  });

  DEFAULT_PROFILES.forEach(profile => {
    describe(`Profile: ${profile.name}`, () => {
      
      test('Has at least 3 stages (or 4 for shiitake)', () => {
        if (profile.species === 'Lentinula edodes' || profile.species === 'Agaricus bisporus') {
           expect(profile.stages.length).toBeGreaterThanOrEqual(4);
        } else {
           expect(profile.stages.length).toBeGreaterThanOrEqual(3);
        }
      });

      profile.stages.forEach(stage => {
        describe(`Stage: ${stage.name}`, () => {
          test('Has all required fields', () => {
            expect(stage).toHaveProperty('temp');
            expect(stage).toHaveProperty('substrate_temp');
            expect(stage).toHaveProperty('humidity');
            expect(stage).toHaveProperty('co2');
            expect(stage).toHaveProperty('fae');
            expect(stage).toHaveProperty('light');
            expect(stage).toHaveProperty('camera');
            expect(stage).toHaveProperty('camera_light');
          });

          test('CO2 max is realistically bounded <= 5000 ppm', () => {
            expect(stage.co2.max).toBeLessThanOrEqual(5000);
          });

          test('CO2 values align with incubation vs fruiting rules', () => {
            const isIncubation = stage.name.toLowerCase().includes('колонизаци') || stage.name.toLowerCase().includes('нанесение покровки') || stage.name.toLowerCase().includes('побурение');
            if (isIncubation) {
              expect(stage.co2.max).toBeLessThanOrEqual(2500);
            } else {
              expect(stage.co2.max).toBeLessThanOrEqual(1000);
            }
          });

          test('Temperature ranges are biologically valid', () => {
            expect(stage.temp.min).toBeLessThan(stage.temp.target);
            expect(stage.temp.target).toBeLessThan(stage.temp.max);
          });

          test('Humidity ranges are valid (40-98%)', () => {
            expect(stage.humidity.min).toBeLessThan(stage.humidity.target);
            expect(stage.humidity.target).toBeLessThan(stage.humidity.max);
            expect(stage.humidity.min).toBeGreaterThanOrEqual(40);
            expect(stage.humidity.max).toBeLessThanOrEqual(98);
          });
        });
      });
    });
  });
});
