import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { MODEL_VERSION, supabase } from '@/lib/supabase';

type Row = {
  id: number;
  name: string;
  team: string;
  pos: string;
  price: number;
  own: number | string | null;
  xpn: number;
};

const POS_COLOR: Record<string, string> = { GK: '#f59e0b', DEF: '#10b981', MID: '#0ea5e9', FWD: '#f43f5e' };

export default function PlayersScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
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
            .range(0, 999);
          for (const r of pj ?? []) proj.set(r.player_id as number, (r.x_pts as number) ?? 0);
        }
        const { data: players } = await supabase
          .from('players')
          .select('fpl_id, web_name, position, now_cost, selected_by_percent, team:teams(short_name)');
        const list: Row[] = (players ?? [])
          .map((p: Record<string, unknown>) => ({
            id: p.fpl_id as number,
            name: p.web_name as string,
            team: (p.team as { short_name?: string } | null)?.short_name ?? '?',
            pos: p.position as string,
            price: ((p.now_cost as number) ?? 0) / 10,
            own: p.selected_by_percent as number | string | null,
            xpn: Math.round((proj.get(p.fpl_id as number) ?? 0) * 10) / 10,
          }))
          .sort((a, b) => b.xpn - a.xpn);
        if (active) setRows(list);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : 'Failed to load players');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(
    () => (q.trim() ? rows.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase())) : rows),
    [q, rows],
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ThemedText type="title" style={styles.h1}>
          Players
        </ThemedText>
        <ThemedText type="small" style={[styles.sub, { color: c.textSecondary }]}>
          Ranked by projected points for the next gameweek.
        </ThemedText>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search player…"
          placeholderTextColor={c.textSecondary}
          autoCapitalize="none"
          style={[styles.search, { backgroundColor: c.backgroundElement, color: c.text }]}
        />
        {loading ? (
          <ActivityIndicator style={styles.loading} />
        ) : err ? (
          <ThemedText style={styles.err}>{err}</ThemedText>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{ paddingBottom: BottomTabInset + Spacing.four }}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: c.backgroundElement }]} />}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={[styles.posDot, { backgroundColor: POS_COLOR[item.pos] ?? '#888' }]} />
                <View style={styles.rowMain}>
                  <ThemedText type="smallBold">{item.name}</ThemedText>
                  <ThemedText type="small" style={{ color: c.textSecondary }}>
                    {item.team} · {item.pos} · £{item.price.toFixed(1)}m
                    {item.own != null ? ` · ${item.own}%` : ''}
                  </ThemedText>
                </View>
                <ThemedText type="smallBold" style={styles.xp}>
                  {item.xpn.toFixed(1)}
                </ThemedText>
              </View>
            )}
          />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: Spacing.three },
  h1: { marginTop: Spacing.two },
  sub: { marginBottom: Spacing.two },
  search: { height: 40, borderRadius: 10, paddingHorizontal: Spacing.three, marginBottom: Spacing.two },
  loading: { marginTop: Spacing.five },
  err: { marginTop: Spacing.three, color: '#f43f5e' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.two },
  rowMain: { flex: 1 },
  posDot: { width: 8, height: 8, borderRadius: 4 },
  xp: { minWidth: 42, textAlign: 'right' },
  sep: { height: StyleSheet.hairlineWidth },
});
