import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { findModel } from '@/lib/catalog';
import { remoteChatStatus } from '@/lib/chat-status';
import { plainText } from '@/lib/markdown';
import type { SessionSummary } from '@/lib/protocol';
import { useStore } from '@/lib/store';
import type { Activity } from '@/lib/transcript';
import { computers, refresh } from '@/services/computers';
import { phone, type LocalChat } from '@/services/phone';
import { ConnectionBanner } from '@/ui/ConnectionBanner';
import { Icon } from '@/ui/Icon';
import { Card, Pill, SectionHeader, T } from '@/ui/kit';
import { Mascot } from '@/ui/Mascot';
import { radius, space, usePalette } from '@/ui/theme';
import { ago } from '@/ui/time';

type Row = { kind: 'remote'; s: SessionSummary; activity?: Activity } | { kind: 'local'; c: LocalChat };

export default function ChatsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const c = useStore(computers, (x) => x);
  const localChats = useStore(phone, (x) => x.chats);
  const live = useStore(phone, (x) => x.live?.chatId);
  const [pulling, setPulling] = useState(false);
  const active = c.computers.find((x) => x.id === c.activeId);

  const sections = useMemo(() => {
    const out: { title: string; key: string; data: Row[] }[] = [];
    if (active) {
      out.push({ title: `On ${active.name}`, key: 'remote', data: c.summaries.map((s) => ({ kind: 'remote', s, activity: c.activity[s.id] })) });
    }
    if (localChats.length) out.push({ title: 'On this phone', key: 'local', data: localChats.map((lc) => ({ kind: 'local', c: lc })) });
    return out;
  }, [active, c.summaries, c.activity, localChats]);

  const empty = !active && localChats.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: p.paper, paddingTop: insets.top }}>
      <View style={styles.header}>
        <T variant="title">Chats</T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={() => router.push('/new')}
          hitSlop={10}
          style={({ pressed }) => [styles.newBtn, { backgroundColor: p.accent, opacity: pressed ? 0.8 : 1 }]}>
          <Icon name="add" size={20} color={p.accentInk} />
        </Pressable>
      </View>
      {empty ? (
        <Welcome />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => (r.kind === 'remote' ? r.s.id : r.c.id)}
          ListHeaderComponent={<ConnectionBanner />}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          refreshControl={
            <RefreshControl
              tintColor={p.accent}
              refreshing={pulling}
              onRefresh={async () => {
                setPulling(true);
                await refresh();
                setPulling(false);
              }}
            />
          }
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
          renderSectionFooter={({ section }) =>
            section.key === 'remote' && section.data.length === 0 ? (
              <T variant="small" tone="faint" style={{ paddingHorizontal: space.lg }}>
                {c.conn === 'online' ? (c.summariesLoading ? 'Loading chats…' : 'No chats yet. Start one with +.') : 'Chats appear here once your computer is online.'}
              </T>
            ) : null
          }
          renderItem={({ item }) => (item.kind === 'remote' ? <RemoteRow s={item.s} activity={item.activity} /> : <LocalRow c={item.c} generating={live === item.c.id} />)}
        />
      )}
    </View>
  );
}

function RemoteRow({ s, activity }: { s: SessionSummary; activity?: Activity }) {
  const p = usePalette();
  const preview = plainText(s.lastReplyText || s.firstUserText || '');
  const status = remoteChatStatus(s, activity);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/chat/[id]', params: { id: s.id } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surface2 : 'transparent' }]}>
      <View style={[styles.avatar, { backgroundColor: p.accentSoft }]}>
        <Icon name="computer" size={16} color={p.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <T variant="heading" numberOfLines={1} style={{ flex: 1 }}>
            {plainText(s.title || '') || 'New chat'}
          </T>
          <T variant="caption" tone="faint">
            {ago(s.updatedAt)}
          </T>
        </View>
        {preview ? (
          <T variant="small" tone="soft" numberOfLines={2}>
            {preview}
          </T>
        ) : null}
        <View style={{ marginTop: 4 }}>
          {status === 'needs-you' ? (
            <Pill label="Needs you" tone="warning" icon="warning" />
          ) : status === 'running' ? (
            <Pill label="Working" tone="accent" icon="bolt" />
          ) : status === 'idle' ? (
            <Pill label="Zz · Idle" />
          ) : (
            <Pill label="Done" icon="check" />
          )}
        </View>
      </View>
    </Pressable>
  );
}

function LocalRow({ c, generating }: { c: LocalChat; generating: boolean }) {
  const p = usePalette();
  const last = c.messages[c.messages.length - 1];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/chat/[id]', params: { id: c.id } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surface2 : 'transparent' }]}>
      <View style={[styles.avatar, { backgroundColor: p.successSoft }]}>
        <Icon name="phone" size={16} color={p.success} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <T variant="heading" numberOfLines={1} style={{ flex: 1 }}>
            {c.title}
          </T>
          <T variant="caption" tone="faint">
            {ago(c.updatedAt)}
          </T>
        </View>
        <T variant="small" tone="soft" numberOfLines={2}>
          {last ? plainText(last.content) : `${findModel(c.modelId)?.name ?? 'On-device model'}, offline and private`}
        </T>
        {generating ? (
          <View style={{ marginTop: 4 }}>
            <Pill label="Writing" tone="success" icon="bolt" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function Welcome() {
  const p = usePalette();
  return (
    <View style={styles.welcome}>
      <Mascot size={88} />
      <T variant="title" style={{ textAlign: 'center', fontSize: 24 }}>
        Your agent, in your pocket
      </T>
      <T tone="soft" style={{ textAlign: 'center' }}>
        Drive Nekko Agent on your computer from here, or chat with an AI model that runs entirely on this phone.
      </T>
      <View style={{ gap: space.md, alignSelf: 'stretch', marginTop: space.lg }}>
        <Pressable accessibilityRole="button" onPress={() => router.push('/pair')}>
          {({ pressed }) => (
            <Card style={[styles.choice, { opacity: pressed ? 0.8 : 1 }]}>
              <View style={[styles.avatar, { backgroundColor: p.accentSoft }]}>
                <Icon name="qr" size={18} color={p.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <T variant="heading">Pair your computer</T>
                <T variant="small" tone="soft">
                  Scan the QR in Settings → Remote access. Start, follow and approve runs from anywhere.
                </T>
              </View>
            </Card>
          )}
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.navigate('/models')}>
          {({ pressed }) => (
            <Card style={[styles.choice, { opacity: pressed ? 0.8 : 1 }]}>
              <View style={[styles.avatar, { backgroundColor: p.successSoft }]}>
                <Icon name="phone" size={18} color={p.success} />
              </View>
              <View style={{ flex: 1 }}>
                <T variant="heading">Chat on this phone</T>
                <T variant="small" tone="soft">
                  Download a small model once. It works offline and nothing you type leaves the phone.
                </T>
              </View>
            </Card>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  newBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatar: { width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, paddingHorizontal: space.xl, paddingBottom: 80 },
  choice: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
});
