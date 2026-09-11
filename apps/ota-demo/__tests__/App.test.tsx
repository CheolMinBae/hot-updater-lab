import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { HotUpdater } from '@hot-updater/react-native';
import App from '../App';

jest.mock('@hot-updater/react-native', () => ({
  HotUpdater: {
    init: jest.fn(),
    checkForUpdate: jest.fn(),
    getBundleId: jest.fn(),
    getAppVersion: jest.fn(),
    getChannel: jest.fn(),
    reload: jest.fn(),
  },
  useHotUpdaterStore: jest.fn(() => 0),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaProvider: View, SafeAreaView: View };
});

type Update = NonNullable<
  Awaited<ReturnType<typeof HotUpdater.checkForUpdate>>
>;
const sdk = jest.mocked(HotUpdater);
const rendered: ReactTestRenderer.ReactTestRenderer[] = [];
const originalDev = __DEV__;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

function availableUpdate() {
  const updateBundle = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
  const update: Update = {
    id: '01a09000-0000-7000-8000-000000000001',
    status: 'UPDATE',
    message: 'Second screen from OTA',
    shouldForceUpdate: false,
    fileUrl: 'https://example.invalid/bundle.tar.gz',
    fileHash: 'a'.repeat(64),
    updateBundle,
  };
  return { update, updateBundle };
}

async function renderApp() {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  rendered.push(tree);
  return tree;
}

function action(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findByProps({ testID });
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  await act(async () => {
    await action(tree, testID).props.onPress();
  });
}

function status(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findByProps({ testID: 'status-message' }).props.children;
}

beforeEach(() => {
  jest.clearAllMocks();
  sdk.checkForUpdate.mockReset();
  sdk.reload.mockReset();
  Object.defineProperty(globalThis, '__DEV__', {
    value: false,
    configurable: true,
  });
  sdk.getAppVersion.mockReturnValue('1.0.0');
  sdk.getChannel.mockReturnValue('rn-demo');
  sdk.getBundleId.mockReturnValue('01a08000-0000-7000-8000-000000000000');
  sdk.checkForUpdate.mockResolvedValue(null);
  sdk.reload.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    rendered.splice(0).forEach(tree => tree.unmount());
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, '__DEV__', {
    value: originalDev,
    configurable: true,
  });
});

test('initializes the SDK once with the public update API', async () => {
  await renderApp();
  expect(sdk.init).toHaveBeenCalledTimes(1);
  expect(sdk.init).toHaveBeenCalledWith({
    baseURL: 'https://ota.prostacks.net/hot-updater',
    onError: expect.any(Function),
  });
});

test('reports no available update when the SDK returns null without an error', async () => {
  const tree = await renderApp();
  await press(tree, 'check-update');
  expect(sdk.checkForUpdate).toHaveBeenCalledWith({
    updateStrategy: 'appVersion',
  });
  expect(status(tree)).toBe('No update available');
  expect(action(tree, 'check-update').props.disabled).toBe(false);
});

test('keeps the SDK callback error when the same check also returns null', async () => {
  sdk.checkForUpdate.mockImplementation(async () => {
    sdk.init.mock.calls[0][0].onError?.(new Error('Connection unavailable'));
    return null;
  });
  const tree = await renderApp();
  await press(tree, 'check-update');
  expect(status(tree)).toBe('Error: Connection unavailable');
  expect(action(tree, 'check-update').props.disabled).toBe(false);
});

test('allows another download attempt after the SDK reports failure', async () => {
  const { update, updateBundle } = availableUpdate();
  updateBundle.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  sdk.checkForUpdate.mockResolvedValue(update);
  const tree = await renderApp();
  await press(tree, 'check-update');
  await press(tree, 'download-update');
  expect(status(tree)).toBe('Error: Download did not complete. Try again.');
  expect(action(tree, 'download-update').props.disabled).toBe(false);
  expect(sdk.reload).not.toHaveBeenCalled();
  await press(tree, 'download-update');
  expect(updateBundle).toHaveBeenCalledTimes(2);
  expect(status(tree)).toBe('Update downloaded');
  expect(action(tree, 'apply-update').props.disabled).toBe(false);
});

test('checks, downloads, and reloads only after the user applies the update', async () => {
  const { update, updateBundle } = availableUpdate();
  sdk.checkForUpdate.mockResolvedValue(update);
  const tree = await renderApp();
  await press(tree, 'check-update');
  expect(status(tree)).toBe('Update available');
  expect(updateBundle).not.toHaveBeenCalled();
  await press(tree, 'download-update');
  expect(updateBundle).toHaveBeenCalledTimes(1);
  expect(status(tree)).toBe('Update downloaded');
  expect(sdk.reload).not.toHaveBeenCalled();
  await press(tree, 'apply-update');
  expect(sdk.reload).toHaveBeenCalledTimes(1);
  expect(status(tree)).toBe('Restarting with downloaded bundle…');
  expect(action(tree, 'apply-update').props.disabled).toBe(true);
});

test('does not start duplicate checks, downloads, or reloads from rapid taps', async () => {
  const checking = deferred<Update | null>();
  const downloading = deferred<boolean>();
  const { update, updateBundle } = availableUpdate();
  sdk.checkForUpdate.mockReturnValue(checking.promise);
  updateBundle.mockReturnValue(downloading.promise);
  const tree = await renderApp();

  await act(async () => {
    const button = action(tree, 'check-update');
    button.props.onPress();
    button.props.onPress();
  });
  expect(sdk.checkForUpdate).toHaveBeenCalledTimes(1);
  expect(action(tree, 'check-update').props.disabled).toBe(true);
  await act(async () => {
    checking.resolve(update);
  });

  await act(async () => {
    const button = action(tree, 'download-update');
    button.props.onPress();
    button.props.onPress();
  });
  expect(updateBundle).toHaveBeenCalledTimes(1);
  expect(action(tree, 'download-update').props.disabled).toBe(true);
  await act(async () => {
    downloading.resolve(true);
  });

  await act(async () => {
    const button = action(tree, 'apply-update');
    button.props.onPress();
    button.props.onPress();
  });
  expect(sdk.reload).toHaveBeenCalledTimes(1);
});

test('explains why a Debug build cannot check for OTA updates', async () => {
  Object.defineProperty(globalThis, '__DEV__', {
    value: true,
    configurable: true,
  });
  const tree = await renderApp();
  await press(tree, 'check-update');
  expect(sdk.checkForUpdate).not.toHaveBeenCalled();
  expect(status(tree)).toBe(
    'Use a Release build to test OTA. Debug uses Metro.',
  );
});
