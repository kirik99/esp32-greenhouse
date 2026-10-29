const fs = require('fs');
const path = require('path');

// Clean up old DATA_DIR if any
process.env.DATA_DIR = path.join(__dirname, 'tmp_test_data');
if (fs.existsSync(process.env.DATA_DIR)) {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}

const store = require('../store');

describe('Store functionality', () => {
  afterAll(() => {
    if (fs.existsSync(process.env.DATA_DIR)) {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
  });

  let boxId;
  let profileId;
  let cycleId;

  test('Box creation and retrieval', () => {
    const box = store.createBox({ name: 'Test Box', device_id: 'DEV-123' });
    expect(box.name).toBe('Test Box');
    boxId = box.id;

    const retrieved = store.getBox(boxId);
    expect(retrieved.id).toBe(boxId);
    
    store.updateBox(boxId, { status: 'maintenance' });
    expect(store.getBox(boxId).status).toBe('maintenance');
  });

  test('Profile creation, update, and retrieval', () => {
    const profile = store.createProfile({
      name: 'Test Profile',
      species: 'Agaricus bisporus',
      stages: [{ id: 'stage_1', name: 'Colo', order: 1 }]
    });
    expect(profile.version).toBe(1);
    profileId = profile.id;

    store.updateProfile(profileId, { description: 'Updated' });
    const retrieved = store.getProfile(profileId);
    expect(retrieved.version).toBe(2);
    expect(retrieved.description).toBe('Updated');
  });

  test('Profile cloning', () => {
    const cloned = store.cloneProfile(profileId, { name: 'Cloned Profile' });
    expect(cloned.id).not.toBe(profileId);
    expect(cloned.name).toBe('Cloned Profile');
    expect(cloned.stages.length).toBe(1);
  });

  test('Cycle creation, stages, harvest, and completion', () => {
    const cycle = store.startCycle({ box_id: boxId, profile_id: profileId, notes: 'Test Cycle' });
    expect(cycle.status).toBe('active');
    cycleId = cycle.id;

    const box = store.getBox(boxId);
    expect(box.active_cycle_id).toBe(cycleId);

    store.setStage(cycleId, 'stage_1');
    expect(store.getCycle(cycleId).current_stage_id).toBe('stage_1');

    store.addHarvest(cycleId, { flush_number: 1, weight_grams: 500 });
    expect(store.getCycle(cycleId).harvests.length).toBe(1);

    store.completeCycle(cycleId, 'completed');
    expect(store.getCycle(cycleId).status).toBe('completed');
    expect(store.getBox(boxId).active_cycle_id).toBeNull();
  });

  test('Error on deleting active profile', () => {
    const p2 = store.createProfile({ name: 'P2', stages: [{id: 's1'}] });
    store.startCycle({ box_id: boxId, profile_id: p2.id });
    expect(() => store.deleteProfile(p2.id)).toThrow();
  });

  test('Photo addition and retrieval', () => {
    const photo = store.addPhoto({ filename: 'test.jpg', box_id: boxId });
    expect(photo.photo_id).toBeDefined();
    
    const photos = store.getPhotos({ box_id: boxId });
    expect(photos.length).toBe(1);
  });

  test('Export dataset format', () => {
    const exportData = store.exportDataset();
    expect(exportData).toHaveProperty('boxes');
    expect(exportData).toHaveProperty('profiles');
    expect(exportData).toHaveProperty('grow_cycles');
    expect(exportData).toHaveProperty('photo_metadata');
  });
});
