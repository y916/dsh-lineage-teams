/**
 * Browser half: the subagent-creation rule card for the plugin manager page.
 *
 * The five fields live in this plugin's Config, so the Host exposes them as the
 * `lineage-teams` settings namespace (the loader row id). The card is mounted on
 * the bundle's detail page and on that row's own configuration page; both read
 * and write the same namespace through `configForms`.
 *
 * Plain module-loader artifact, no build step: React comes from the browser
 * module table and everything else is strings.
 */
window.__ModuleLoader__.load({
  id: '@y916/dsh-lineage-teams',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOCALE_NS = 'lineage-teams-settings'
    const CONFIG_NS = 'lineage-teams'
    const BUNDLE = '@y916/dsh-lineage-teams'
    const ROW_KEY = `${BUNDLE}#lineage-teams`
    const FIELDS = ['idleRatioLimit', 'idleCountLimit', 'allowDifferentPreset', 'allowDifferentModel', 'allowDifferentCwd']
    const DEFAULTS = {
      idleRatioLimit: 50,
      idleCountLimit: 3,
      allowDifferentPreset: false,
      allowDifferentModel: false,
      allowDifferentCwd: false,
    }

    const zh = {
      title: '子代理创建规则',
      intro: '两个上限必须同时满足才允许新建子代理；超过上限时，只有命中已开启的差异豁免才放行。保存后立即生效，无需重启或重开对话。',
      ratioLabel: '空闲子代理比例上限',
      ratioHint: '0–100%：空闲比例不超过该值时才允许新建。',
      countLabel: '空闲子代理数量上限',
      countHint: '0–10：空闲数量不超过该值时才允许新建；与比例上限同时满足。',
      presetLabel: '允许因预设不同而新建',
      presetHint: '超过上限时，若空闲代理中没有所请求的 agent_preset，允许新建。',
      modelLabel: '允许因模型不同而新建',
      modelHint: '超过上限时，若空闲代理中没有所请求的 provider+model，允许新建（reasoning_effort 不参与比较）。',
      cwdLabel: '允许因工作目录不同而新建',
      cwdHint: '超过上限时，若空闲代理中没有所请求的 cwd，允许新建。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，立即生效',
      failed: '保存失败，请重试',
      reset: '恢复默认',
      resetHint: '恢复为：比例 50%、数量 3、三个开关全关。',
      loading: '正在读取配置…',
      unavailable: '当前 profile 未提供该插件的配置命名空间。',
      readOnly: '当前配置不可写。',
      on: '开',
      off: '关',
      current: '当前：比例 ≤ {ratio}%，数量 ≤ {count}；差异豁免：预设 {preset}、模型 {model}、目录 {cwd}',
      effectiveNow: '设置保存后立即生效；对话中的规则上下文会在下一步更新。',
    }

    const en = {
      title: 'Subagent creation rule',
      intro: 'Both limits must hold to create a subagent; beyond them, only an enabled difference exception allows creation. Saved changes apply immediately, without a restart or a new conversation.',
      ratioLabel: 'Maximum idle subagent ratio',
      ratioHint: '0–100%: creation is allowed only while the idle ratio is at or below this value.',
      countLabel: 'Maximum idle subagent count',
      countHint: '0–10: creation is allowed only while the idle count is at or below this value, together with the ratio limit.',
      presetLabel: 'Allow a different agent preset',
      presetHint: 'Beyond the limits, allow creation when no idle subagent has the requested agent_preset.',
      modelLabel: 'Allow a different model',
      modelHint: 'Beyond the limits, allow creation when no idle subagent has the requested provider+model (reasoning_effort is not compared).',
      cwdLabel: 'Allow a different working directory',
      cwdHint: 'Beyond the limits, allow creation when no idle subagent has the requested cwd.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; applies immediately',
      failed: 'Save failed; retry',
      reset: 'Restore defaults',
      resetHint: 'Restores ratio 50%, count 3, all switches off.',
      loading: 'Reading configuration…',
      unavailable: 'This profile does not serve the configuration namespace for this plugin.',
      readOnly: 'Configuration is not writable.',
      on: 'on',
      off: 'off',
      current: 'Current: ratio ≤ {ratio}%, count ≤ {count}; exceptions: preset {preset}, model {model}, cwd {cwd}',
      effectiveNow: 'Saving applies immediately; the rule context in a conversation updates on the next step.',
    }

    const styles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      intro: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      field: {
        display: 'grid',
        gridTemplateColumns: 'minmax(200px, 1fr) minmax(180px, 2fr) auto',
        alignItems: 'center',
        columnGap: '12px',
        rowGap: '2px',
      },
      label: { fontSize: '13px', lineHeight: '20px' },
      hint: {
        gridColumn: '1 / -1',
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      value: {
        minWidth: '40px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      toggleField: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
      },
      toggleLabel: { display: 'flex', flexDirection: 'column', gap: '1px' },
      toggleHint: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: {
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 12px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      buttonGhost: {
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      status: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      statusError: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      notice: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'lineage-teams: settings dictionaries')
        const t = ctx.locale.bind(LOCALE_NS)
        const form = ctx.configForms.get(CONFIG_NS)

        const pick = (snapshot) => {
          const value = snapshot?.value ?? {}
          const ratio = Number(value.idleRatioLimit)
          const count = Number(value.idleCountLimit)
          return {
            idleRatioLimit: Number.isFinite(ratio) ? Math.min(100, Math.max(0, Math.round(ratio))) : DEFAULTS.idleRatioLimit,
            idleCountLimit: Number.isFinite(count) ? Math.min(10, Math.max(0, Math.round(count))) : DEFAULTS.idleCountLimit,
            allowDifferentPreset: value.allowDifferentPreset === true,
            allowDifferentModel: value.allowDifferentModel === true,
            allowDifferentCwd: value.allowDifferentCwd === true,
          }
        }

        const summaryText = (value) => t('current', {
          ratio: value.idleRatioLimit,
          count: value.idleCountLimit,
          preset: value.allowDifferentPreset ? t('on') : t('off'),
          model: value.allowDifferentModel ? t('on') : t('off'),
          cwd: value.allowDifferentCwd ? t('on') : t('off'),
        })

        function SettingsCard(props) {
          const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
          const [draft, setDraft] = React.useState(() => pick(form.getSnapshot()))
          const [dirty, setDirty] = React.useState(false)
          const [status, setStatus] = React.useState('idle')

          React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [])
          React.useEffect(() => {
            if (snapshot.status === 'ready' && !dirty) setDraft(pick(snapshot))
          }, [snapshot, dirty])

          if (props.view === 'summary') return h('span', null, summaryText(draft))
          if (snapshot.status === 'loading') return h('p', { style: styles.hint }, t('loading'))
          if (snapshot.status === 'unavailable') return h('p', { style: styles.hint }, t('unavailable'))

          const writable = snapshot.writable === true
          const busy = status === 'saving'
          const update = (field, value) => {
            setDraft({ ...draft, [field]: value })
            setDirty(true)
            setStatus('idle')
          }
          const save = async () => {
            setStatus('saving')
            try {
              const accepted = await form.mutate(FIELDS.map((field) => ({ op: 'set', path: [field], value: draft[field] })), snapshot.revision)
              setStatus(accepted ? 'saved' : 'failed')
              if (accepted) setDirty(false)
            } catch {
              setStatus('failed')
            }
          }
          const reset = async () => {
            setStatus('saving')
            try {
              const accepted = await form.mutate(FIELDS.map((field) => ({ op: 'unset', path: [field] })), snapshot.revision)
              setStatus(accepted ? 'saved' : 'failed')
              if (accepted) setDirty(false)
            } catch {
              setStatus('failed')
            }
          }

          const range = (field, label, hint, min, max) => h('div', { style: styles.field },
            h('label', { style: styles.label, htmlFor: `lt-${field}` }, label),
            h('input', {
              id: `lt-${field}`,
              type: 'range',
              min,
              max,
              step: 1,
              value: draft[field],
              disabled: !writable || busy,
              onChange: (event) => update(field, Number(event.target.value)),
            }),
            h('span', { style: styles.value }, field === 'idleRatioLimit' ? `${draft[field]}%` : String(draft[field])),
            h('p', { style: styles.hint }, hint),
          )

          const toggle = (field, label, hint) => h('div', { style: styles.toggleField },
            h('input', {
              id: `lt-${field}`,
              type: 'checkbox',
              checked: draft[field],
              disabled: !writable || busy,
              onChange: (event) => update(field, event.target.checked),
            }),
            h('label', { style: styles.toggleLabel, htmlFor: `lt-${field}` },
              h('span', { style: styles.label }, label),
              h('span', { style: styles.toggleHint }, hint),
            ),
          )

          return h('div', { style: styles.card, 'data-lineage-teams-settings': 'page' },
            h('h3', { style: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 500 } }, t('title')),
            h('p', { style: styles.intro }, t('intro')),
            range('idleRatioLimit', t('ratioLabel'), t('ratioHint'), 0, 100),
            range('idleCountLimit', t('countLabel'), t('countHint'), 0, 10),
            toggle('allowDifferentPreset', t('presetLabel'), t('presetHint')),
            toggle('allowDifferentModel', t('modelLabel'), t('modelHint')),
            toggle('allowDifferentCwd', t('cwdLabel'), t('cwdHint')),
            h('p', { style: styles.notice }, summaryText(draft)),
            h('p', { style: styles.notice }, t('effectiveNow')),
            h('div', { style: styles.actions },
              h('button', {
                type: 'button',
                style: styles.button,
                disabled: !writable || busy || !dirty,
                onClick: save,
              }, busy ? t('saving') : t('save')),
              h('button', {
                type: 'button',
                style: styles.buttonGhost,
                disabled: !writable || busy,
                onClick: reset,
              }, t('reset')),
              status === 'idle' ? null : h('span', { style: status === 'failed' ? styles.statusError : styles.status }, t(status === 'saved' ? 'saved' : status === 'saving' ? 'saving' : 'failed')),
            ),
            writable ? null : h('p', { style: styles.notice }, t('readOnly')),
          )
        }

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE,
        }, SettingsCard))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
        }, SettingsCard))
      },
    }
  },
})
