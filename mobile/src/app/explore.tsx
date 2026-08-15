import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { MODEL_VERSION, supabase } from '@/lib/supabase';

// Increment 1 shows the shared "me" demo squad (public via RLS). A later increment swaps this for the
// signed-in user's own team once auth lands.
const DEMO_USER = 'me';
const POS_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
const POS_COLOR: Record<string, string> = { GK: '#f59e0b', DEF: '#10b981', MID: '#0ea5e9', FWD: '#f43f5e' };

type P = {
  id: number;
  name: string;
  team: string;
  pos: string;
  price: number;
  xpn: number;
  starter: boolean;
  captain: boolean;
  vice: boolean;
};

export default function TeamScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const [squad, setSquad] = useState<P[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data: st } = await supabase
          .from('user_team_state')
          .select('*')
          .eq('user_id', DEMO_USER)
          .order('gw', { ascending: false })
          .limit(1);
        const team = st?.[0] as { picks?: Record<string, unknown>[] } | undefined;
        if (!team?.picks?.length) {
          if (active) {
            setMsg('No team synced yet.');
            setLoading(false);
          }
          return;
        }
        const picks = team.picks as { element: number; position: number; is_captain?: boolean; is_vice_captain?: boolean }[];
        const ids = picks.map((p) => p.element);

        const { data: gwRows } = await supabase
          .from('projections')
          .select('gw')
          .eq('model_version', MODEL_VERSION)
          .order('gw', { ascending: true })
          .limit(1);
        const gw = gwRows?.[0]?.gw as number | undefined;
        const proj = new Map<number, number>();
        if (gw != null) {
          const { data: pj } = await supabase
            .from('projections')
            .select('player_id, x_pts')
            .eq('model_version', MODEL_VERSION)
            .eq('gw', gw)
            .in('player_id', ids);
          for (const r of pj ?? []) proj.set(r.player_id as number, (r.x_pts as number) ?? 0);
        }
        const { data: players } = await supabase
          .from('players')
          .select('fpl_id, web_name, position, now_cost, team:teams(short_name)')
          .in('fpl_id', ids);
        const byId = new Map((players ?? []).map((p: Record<string, unknown>) => [p.fpl_id as number, p]));

        const list: P[] = picks
          .map((pk) => {
            const p = byId.get(pk.element) as Record<string, unknown> | undefined;
            return {
              id: pk.element,
              name: (p?.web_name as string) ?? String(pk.element),
              team: (p?.team as { short_name?: string } | null)?.short_name ?? '?',
              pos: (p?.position as string) ?? '?',
              price: ((p?.now_cost as number) ?? 0) / 10,
              xpn: Math.round((proj.get(pk.element) ?? 0) * 10) / 10,
              starter: pk.position <= 11,
              captain: !!pk.is_captain,
              vice: !!pk.is_vice_captain,
            };
          })
          .sort((a, b) => (POS_ORDER[a.pos] ?? 9) - (POS_ORDER[b.pos] ?? 9));
        if (active) setSquad(list);
      } catch (e) {
        if (active) setMsg(e instanceof Error ? e.message : 'Failed to load team');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const starters = squad.filter((p) => p.starter);
  const bench = squad.filter((p) => !p.starter);
  const xi = starters.reduce((s, p) => s + p.xpn, 0) + (starters.find((p) => p.captain)?.xpn ?? 0);

  const PlayerRow = ({ p }: { p: P }) => (
    <View style={styles.row}>
      <View style={[styles.posDot, { backgroundColor: POS_COLOR[p.pos] ?? '#888' }]} />
      <View style={styles.rowMain}>
        <ThemedText type="smallBold">
          {p.name}
          {p.captain ? '  (C)' : p.vice ? '  (V)' : ''}
        </ThemedText>
        <ThemedText type="small" style={{ color: c.textSecondary }}>
          {p.team} · {p.pos} · £{p.price.toFixed(1)}m
        </ThemedText>
      </View>
      <ThemedText type="smallBold" style={styles.xp}>
        {p.xpn.toFixed(1)}
      </ThemedText>
    </View>
  );

  const Section = ({ title, items }: { title: string; items: P[] }) => (
    <View style={styles.section}>
      <ThemedText type="small" style={[styles.sectionLabel, { color: c.textSecondary }]}>
        {title}
      </ThemedText>
      <ThemedView type="backgroundElement" style={styles.card}>
        {items.map((p, i) => (
          <View key={p.id}>
            {i > 0 && <View style={[styles.sep, { backgroundColor: c.backgroundSelected }]} />}
            <PlayerRow p={p} />
          </View>
        ))}
      </ThemedView>
    </View>
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ThemedText type="title" style={styles.h1}>
          My Team
        </ThemedText>
        <ThemedText type="small" style={[styles.sub, { color: c.textSecondary }]}>
          {squad.length ? `Projected XI (captain doubled): ${xi.toFixed(1)} pts` : 'Demo squad'}
        </ThemedText>
        {loading ? (
          <ActivityIndicator style={styles.loading} />
        ) : msg ? (
          <ThemedText style={{ marginTop: Spacing.three, color: c.textSecondary }}>{msg}</ThemedText>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: BottomTabInset + Spacing.four }}>
            <Section title="STARTING XI" items={starters} />
            <Section title="BENCH" items={bench} />
          </ScrollView>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: Spacing.three },
  h1: { marginTop: Spacing.two },
  sub: { marginBottom: Spacing.three },
  loading: { marginTop: Spacing.five },
  section: { marginBottom: Spacing.three },
  sectionLabel: { marginBottom: Spacing.one, letterSpacing: 1 },
  card: { borderRadius: 12, paddingHorizontal: Spacing.three },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.two },
  rowMain: { flex: 1 },
  posDot: { width: 8, height: 8, borderRadius: 4 },
  xp: { minWidth: 42, textAlign: 'right' },
  sep: { height: StyleSheet.hairlineWidth },
});
