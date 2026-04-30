import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, FeatureStatus } from '../../lib/design';
import { TabStrip, TabKey } from '../../components/termloop/TabStrip';
import { WorkspaceHeader } from '../../components/termloop/WorkspaceHeader';
import { EpicRow } from '../../components/termloop/EpicRow';
import { FeatureRow } from '../../components/termloop/FeatureRow';
import { ShellRow } from '../../components/termloop/ShellRow';
import { CmdBar } from '../../components/termloop/CmdBar';
import { FilterRail } from '../../components/termloop/FilterRail';
import { FeaturePreviewPanel } from '../../components/termloop/FeaturePreviewPanel';

interface Feature {
  id: string;
  title: string;
  status: FeatureStatus;
  summary: string;
  activity: string;
  agent?: string;
  bullet?: '·' | '✳';
  branch: string;
  path: string;
}
interface Epic {
  id: string;
  name: string;
  features: Feature[];
  current?: boolean;
  shell?: { user: string; host: string; path: string };
}

const PATH = '~/Projects/bmadworkflowtest';
type WorkFilterKey = 'all' | 'run' | 'input' | 'idle' | 'current';

const MOCK_EPICS: Epic[] = [
  {
    id: 'mobileapp',
    name: 'Mobileapp',
    features: [
      {
        id: 'persistence',
        title: 'Persistence',
        status: 'run',
        summary: 'Keep terminal sessions and TermLoop state durable across app resumes.',
        activity: 'Sync loop ran 12m ago',
        agent: 'storage-agent',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'project',
    name: 'Project',
    features: [
      {
        id: 'p-1',
        title: 'Project layer data model',
        status: 'run',
        summary: 'Unify project entities so workspaces, epics, and features resolve from one source.',
        activity: 'Schema diff updated 9m ago',
        agent: 'model-coder',
        branch: 'master*',
        path: PATH,
      },
      {
        id: 'p-2',
        title: 'Socket methods for project.*',
        status: 'idle',
        summary: 'Expose project tree updates and workspace mutations through the app socket layer.',
        activity: 'Waiting on API shape',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'worktree',
    name: 'Worktree',
    features: [
      {
        id: 'w-1',
        title: 'Set up worktree support in TermLoop',
        status: 'run',
        summary: 'Add first-class worktree creation and switching to the TermLoop shell workflow.',
        activity: 'Linked to 2 workspace prototypes',
        agent: 'shell-runner',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'pluginsystem',
    name: 'Pluginsystem',
    features: [
      {
        id: 'pl-1',
        title: 'Design extensible plugin system',
        status: 'input',
        summary: 'Define plugin capability boundaries before connector APIs harden.',
        activity: 'Needs review from platform',
        branch: 'master*',
        path: PATH,
      },
      {
        id: 'pl-2',
        title: 'Plugin manifest schema',
        status: 'idle',
        summary: 'Translate plugin concepts into a serializable manifest and validation rules.',
        activity: 'Backlog',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'ui',
    name: 'Ui',
    features: [
      {
        id: 'u-1',
        title: 'remove-workspace-description-sidebar',
        status: 'idle',
        summary: 'Reduce sidebar noise by moving descriptive text into richer contextual surfaces.',
        activity: 'Queued after review',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'gitchanges',
    name: 'Gitchanges',
    features: [
      {
        id: 'g-1',
        title: 'Assess TermLoop fork git integration diff',
        status: 'input',
        summary: 'Audit upstream/downstream divergence and isolate the smallest safe merge surface.',
        activity: 'Diff review blocked on notes',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'agents',
    name: 'Agents',
    features: [
      {
        id: 'a-1',
        title: 'Design executable agents for TermLoop',
        status: 'run',
        summary: 'Turn agent definitions into runnable workspace-side flows with visible state.',
        activity: 'Runner API drafted',
        agent: 'agent-ops',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'superpowers',
    name: 'Superpowers',
    features: [
      {
        id: 's-1',
        title: 'Add project overview tab with live agent',
        status: 'run',
        summary: 'Give workspaces a live project overview surface that can host active agents.',
        activity: 'UI slice landed',
        agent: 'ux-agent',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'map',
    name: 'Map',
    features: [
      {
        id: 'm-1',
        title: 'Persistence layer for map view',
        status: 'idle',
        summary: 'Store navigation graph state so map mode can resume where the user left off.',
        activity: 'No active run',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'mobileui',
    name: 'Mobileui',
    features: [
      {
        id: 'mu-1',
        title: 'Fix mobile app selection feedback UI',
        status: 'run',
        summary: 'Make focused and selected states clearer on touch so the tree feels intentional.',
        activity: 'Touch polish in progress',
        agent: 'mobile-ui',
        branch: 'master*',
        path: PATH,
      },
    ],
  },
  {
    id: 'startupbuilder',
    name: 'Startupbuilder',
    current: true,
    features: [
      {
        id: 'sb-1',
        title: 'AI-driven project planning and parallel d…',
        status: 'input',
        summary: 'Coordinate project planning, multi-agent delegation, and visibility from one flow.',
        activity: 'Needs direction on review flow',
        agent: 'planner',
        bullet: '✳',
        branch: 'master*',
        path: PATH,
      },
    ],
    shell: { user: 'feritzcan', host: 'Mac', path: '~/Projects/bmadworkflowt…' },
  },
];

export default function CmuxTreeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<TabKey>('work');
  const [filter, setFilter] = useState<WorkFilterKey>('all');
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(['mobileui', 'startupbuilder'])
  );
  const [selectedId, setSelectedId] = useState<string | null>('mu-1');

  const workspaceName = (id || 'termloop').toString();
  const compact = width < 390;
  const narrow = width < 350;
  const wide = width >= 768;
  const showPreview = width >= 1024;
  const sidebarMaxWidth = wide ? 500 : undefined;

  const flatFeatures = useMemo(
    () =>
      MOCK_EPICS.flatMap((epic) =>
        epic.features.map((feature) => ({
          epicId: epic.id,
          epicName: epic.name,
          current: epic.current,
          feature,
        }))
      ),
    []
  );

  const filterItems = useMemo(() => {
    const count = (key: WorkFilterKey) => {
      if (key === 'all') return flatFeatures.length;
      if (key === 'current') return flatFeatures.filter((item) => item.current).length;
      return flatFeatures.filter((item) => item.feature.status === key).length;
    };

    return [
      { key: 'all', label: 'All', count: count('all') },
      { key: 'run', label: 'Running', count: count('run') },
      { key: 'input', label: 'Needs Input', count: count('input') },
      { key: 'idle', label: 'Idle', count: count('idle') },
      { key: 'current', label: 'Current Epic', count: count('current') },
    ];
  }, [flatFeatures]);

  const filteredEpics = useMemo(() => {
    return MOCK_EPICS.map((epic) => {
      const features = epic.features.filter((feature) => {
        if (filter === 'all') return true;
        if (filter === 'current') return Boolean(epic.current);
        return feature.status === filter;
      });

      return {
        ...epic,
        features,
      };
    }).filter((epic) => epic.features.length > 0 || (filter === 'current' && epic.current));
  }, [filter]);

  const visibleFeatures = useMemo(
    () =>
      filteredEpics.flatMap((epic) =>
        epic.features.map((feature) => ({
          epicId: epic.id,
          epicName: epic.name,
          current: epic.current,
          feature,
        }))
      ),
    [filteredEpics]
  );

  const selectedFeatureContext = useMemo(() => {
    if (visibleFeatures.length === 0) return null;
    return visibleFeatures.find((item) => item.feature.id === selectedId) ?? visibleFeatures[0];
  }, [selectedId, visibleFeatures]);

  const visibleFeatureIds = useMemo(
    () => new Set(filteredEpics.flatMap((epic) => epic.features.map((feature) => feature.id))),
    [filteredEpics]
  );

  const workspaceStats = useMemo(() => {
    const running = flatFeatures.filter((item) => item.feature.status === 'run').length;
    const input = flatFeatures.filter((item) => item.feature.status === 'input').length;
    const idle = flatFeatures.filter((item) => item.feature.status === 'idle').length;
    return [
      { label: 'Running', value: String(running).padStart(2, '0'), tone: 'run' as const },
      { label: 'Needs Input', value: String(input).padStart(2, '0'), tone: 'input' as const },
      { label: 'Idle', value: String(idle).padStart(2, '0'), tone: 'idle' as const },
    ];
  }, [flatFeatures]);

  useEffect(() => {
    if (selectedId && visibleFeatureIds.has(selectedId)) return;
    const nextVisibleId = filteredEpics.flatMap((epic) => epic.features)[0]?.id ?? null;
    setSelectedId(nextVisibleId);
  }, [filteredEpics, selectedId, visibleFeatureIds]);

  function toggleEpic(epicId: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) next.delete(epicId);
      else next.add(epicId);
      return next;
    });
  }

  const content = useMemo(() => {
    return filteredEpics.map((epic) => {
      const open = openIds.has(epic.id);
      return (
        <View key={epic.id}>
          <EpicRow
            name={epic.name}
            count={epic.features.length}
            open={open}
            current={epic.current}
            compact={compact}
            onPress={() => toggleEpic(epic.id)}
          />
          {open && epic.features.map((f) => (
            <FeatureRow
              key={f.id}
              title={f.title}
              status={f.status}
              branch={f.branch}
              meta={f.activity}
              path={f.path}
              bullet={f.bullet}
              selected={selectedId === f.id}
              compact={compact}
              onPress={() => setSelectedId(f.id)}
            />
          ))}
          {open && epic.shell && (
            <ShellRow
              user={epic.shell.user}
              host={epic.shell.host}
              path={epic.shell.path}
              compact={compact}
            />
          )}
        </View>
      );
    });
  }, [compact, filteredEpics, openIds, selectedId]);

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.stage, wide && styles.stageWide, showPreview && styles.stagePreview]}>
        <View
          style={[
            styles.surface,
            wide && styles.surfaceWide,
            compact && styles.surfaceCompact,
            showPreview && styles.surfacePreview,
            { maxWidth: sidebarMaxWidth },
          ]}
        >
          <View style={styles.chrome}>
            <Pressable
              style={[styles.back, compact && styles.backCompact]}
              onPress={() => router.back()}
              hitSlop={12}
            >
              <Text style={[styles.backText, compact && styles.backTextCompact]}>‹ back</Text>
            </Pressable>
            <TabStrip value={tab} onChange={setTab} compact={compact} />
            <WorkspaceHeader
              name={workspaceName}
              compact={compact}
              badge="WORKBOARD"
              subtitle="Focus your active work, triage input-needed tasks, and jump into the selected feature."
              stats={workspaceStats}
            />
            <FilterRail
              items={filterItems}
              value={filter}
              compact={compact}
              onChange={(key) => setFilter(key as WorkFilterKey)}
            />
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.scrollContent,
              compact && styles.scrollContentCompact,
              { paddingBottom: 24 + insets.bottom },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {content}
          </ScrollView>
          <CmdBar label="New epic" kbd={narrow ? undefined : '⌘N'} compact={compact} disabled />
        </View>
        {showPreview && selectedFeatureContext && (
          <FeaturePreviewPanel
            title={selectedFeatureContext.feature.title}
            status={selectedFeatureContext.feature.status}
            summary={selectedFeatureContext.feature.summary}
            activity={selectedFeatureContext.feature.activity}
            branch={selectedFeatureContext.feature.branch}
            path={selectedFeatureContext.feature.path}
            epicName={selectedFeatureContext.epicName}
            agent={selectedFeatureContext.feature.agent}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  stage: {
    flex: 1,
  },
  stageWide: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    alignItems: 'center',
  },
  stagePreview: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 16,
  },
  surface: {
    flex: 1,
    width: '100%',
    minHeight: 0,
    backgroundColor: colors.bg,
  },
  surfacePreview: {
    flexBasis: 480,
    flexGrow: 0,
  },
  surfaceWide: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: colors.bgInk,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  surfaceCompact: {
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderRadius: 0,
  },
  chrome: {
    backgroundColor: colors.bg,
  },
  back: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 2,
  },
  backText: {
    fontFamily: font.mono,
    color: colors.ink3,
    fontSize: 12,
    letterSpacing: 1.2,
  },
  backCompact: {
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  backTextCompact: {
    fontSize: 11,
    letterSpacing: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  scrollContentCompact: {
    paddingBottom: 16,
  },
});
