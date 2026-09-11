import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { HotUpdater, useHotUpdaterStore } from '@hot-updater/react-native';
import { release } from './src/release';

const UPDATE_URL = 'https://ota.prostacks.net/hot-updater';
type Update = NonNullable<
  Awaited<ReturnType<typeof HotUpdater.checkForUpdate>>
>;
type Phase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'restarting';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function DemoScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('Ready to check');
  const [update, setUpdate] = useState<Update | null>(null);
  const [runningBundleId] = useState(() => HotUpdater.getBundleId());
  const operation = useRef(false);
  const sdkError = useRef<unknown>(null);
  const progress = useHotUpdaterStore(state => state.progress);

  useEffect(() => {
    HotUpdater.init({
      baseURL: UPDATE_URL,
      onError: error => {
        sdkError.current = error;
        setMessage(`Error: ${errorMessage(error)}`);
      },
    });
  }, []);

  async function check() {
    if (operation.current) {
      return;
    }
    if (__DEV__) {
      setMessage('Use a Release build to test OTA. Debug uses Metro.');
      return;
    }
    operation.current = true;
    sdkError.current = null;
    setUpdate(null);
    setPhase('checking');
    setMessage('Checking for updates…');
    try {
      const next = await HotUpdater.checkForUpdate({
        updateStrategy: 'appVersion',
      });
      // The SDK reports network errors through onError and also returns null.
      if (sdkError.current) {
        throw sdkError.current;
      }
      setUpdate(next);
      setPhase(next ? 'available' : 'idle');
      setMessage(next ? 'Update available' : 'No update available');
    } catch (error) {
      setPhase('idle');
      setMessage(`Error: ${errorMessage(error)}`);
    } finally {
      operation.current = false;
    }
  }

  async function download() {
    if (!update || operation.current) {
      return;
    }
    operation.current = true;
    sdkError.current = null;
    setPhase('downloading');
    setMessage(
      update.status === 'ROLLBACK'
        ? 'Preparing rollback…'
        : 'Downloading update…',
    );
    try {
      const success = await update.updateBundle();
      if (!success) {
        throw (
          sdkError.current || new Error('Download did not complete. Try again.')
        );
      }
      setPhase('ready');
      setMessage('Update downloaded');
    } catch (error) {
      setPhase('available');
      setMessage(`Error: ${errorMessage(error)}`);
    } finally {
      operation.current = false;
    }
  }

  async function restart() {
    if (operation.current) {
      return;
    }
    operation.current = true;
    setPhase('restarting');
    setMessage('Restarting with downloaded bundle…');
    try {
      await HotUpdater.reload();
    } catch (error) {
      operation.current = false;
      setPhase('ready');
      setMessage(`Error: ${errorMessage(error)}`);
    }
  }

  const busy =
    phase === 'checking' || phase === 'downloading' || phase === 'restarting';
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor="#111318" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PROSTACKS / OTA LAB</Text>
        <Text style={styles.title}>A new screen.{'\n'}Same app.</Text>
        <Text style={styles.subtitle}>
          앱 재설치 없이 JS 번들을 업데이트하는 React Native 데모
        </Text>
        <View style={[styles.card, { borderColor: release.accent }]}>
          <Text style={styles.caption}>RUNNING CONTENT</Text>
          <Text
            testID="release-label"
            style={[styles.release, { color: release.accent }]}
          >
            {release.label}
          </Text>
          <Text style={styles.body}>{release.message}</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.row}>
            <View>
              <Text style={styles.caption}>NATIVE APP</Text>
              <Text style={styles.value}>
                {HotUpdater.getAppVersion() || 'Unknown'}
              </Text>
            </View>
            <View>
              <Text style={styles.caption}>CHANNEL</Text>
              <Text style={styles.value}>{HotUpdater.getChannel()}</Text>
            </View>
          </View>
          <Text style={styles.caption}>CURRENT BUNDLE ID</Text>
          <Text selectable style={styles.mono}>
            {runningBundleId}
          </Text>
        </View>
        <View style={styles.status}>
          <Text style={styles.caption}>UPDATE STATUS</Text>
          <Text
            testID="status-message"
            accessibilityLiveRegion="polite"
            style={styles.statusText}
          >
            {message}
          </Text>
          {update ? (
            <Text style={styles.small}>
              {update.status} · {update.id}
              {update.message ? `\n${update.message}` : ''}
            </Text>
          ) : null}
          {phase === 'downloading' ? (
            <>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${percent}%` }]} />
              </View>
              <Text style={styles.small}>{percent}%</Text>
            </>
          ) : null}
        </View>
        {phase === 'ready' || phase === 'restarting' ? (
          <Action
            label="Apply and restart"
            testID="apply-update"
            onPress={restart}
            disabled={busy}
          />
        ) : phase === 'available' || phase === 'downloading' ? (
          <Action
            label="Download update"
            testID="download-update"
            onPress={download}
            disabled={busy}
          />
        ) : (
          <Action
            label="Check for update"
            testID="check-update"
            onPress={check}
            disabled={busy}
          />
        )}
        <Text style={styles.footer}>
          Hot Updater SDK 0.36.11{'\n'}ota.prostacks.net · rn-demo
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Action({
  label,
  testID,
  onPress,
  disabled,
}: {
  label: string;
  testID: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <DemoScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111318' },
  content: {
    padding: 24,
    gap: 20,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  eyebrow: {
    color: '#aaaeba',
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
  },
  title: {
    color: '#f5f6fa',
    fontSize: 38,
    lineHeight: 43,
    fontWeight: '700',
    letterSpacing: -1,
  },
  subtitle: { color: '#aeb4c2', fontSize: 14, lineHeight: 22 },
  card: {
    backgroundColor: '#1b1f27',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#323947',
    padding: 20,
    gap: 10,
  },
  caption: {
    fontSize: 10,
    color: '#aeb4c2',
    letterSpacing: 1.3,
    fontWeight: '700',
  },
  release: { fontSize: 28, fontWeight: '700' },
  body: { color: '#e2e6ee', fontSize: 14, lineHeight: 22 },
  row: { flexDirection: 'row', gap: 56, marginBottom: 12 },
  value: { fontSize: 18, color: '#f5f6fa', marginTop: 8, fontWeight: '600' },
  mono: {
    fontSize: 12,
    color: '#d5dbe7',
    lineHeight: 20,
    fontFamily: 'monospace',
  },
  status: { gap: 10, minHeight: 66 },
  statusText: { fontSize: 16, color: '#f5f6fa', lineHeight: 23 },
  small: { fontSize: 12, color: '#aeb4c2', lineHeight: 18 },
  progressTrack: {
    height: 5,
    borderRadius: 4,
    backgroundColor: '#323947',
    overflow: 'hidden',
  },
  progressFill: { height: 5, backgroundColor: '#ff8b54' },
  button: {
    backgroundColor: '#ff8b54',
    borderRadius: 12,
    minHeight: 54,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, color: '#18130f', fontWeight: '700' },
  dim: { opacity: 0.55 },
  footer: {
    color: '#949baa',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 18,
    marginBottom: 8,
  },
});
