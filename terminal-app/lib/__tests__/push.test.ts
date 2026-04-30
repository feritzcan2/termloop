jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getDevicePushTokenAsync: jest.fn(async () => ({ data: 'fake-token', type: 'ios' })),
  setNotificationCategoryAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

const mockClient = {
  pushRegister: jest.fn(async () => ({ registered: true })),
  onReconnect: jest.fn(() => () => {}),
};

jest.mock('../termloop-client-singleton', () => ({
  getTermLoopClient: () => mockClient,
}));

import { startPushLifecycle } from '../push';

describe('push lifecycle', () => {
  beforeEach(() => {
    mockClient.pushRegister.mockClear();
    mockClient.onReconnect.mockClear();
  });

  test('registers token on start', async () => {
    await startPushLifecycle({ onAction: () => {} });
    expect(mockClient.pushRegister).toHaveBeenCalledWith(
      'fake-token',
      'ios',
      expect.stringMatching(/development|production/)
    );
  });

  test('wires reconnect to re-register', async () => {
    await startPushLifecycle({ onAction: () => {} });
    expect(mockClient.onReconnect).toHaveBeenCalled();
  });
});
