import { useEffect, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Blocks,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Cloud,
  Database,
  FileSpreadsheet,
  GitBranch,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  Settings2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'

type FlowData = {
  label: string
  subtitle: string
  config: Record<string, string>
}

type SavedWorkflow = {
  id: number
  workspace_id: number
  name: string
  description: string | null
  status: string
  graph: { nodes?: Node<FlowData>[]; edges?: Edge[] }
  created_by: number
}

type Workspace = { id: number; name: string; description?: string | null }
type User = { id: number; email: string; full_name: string; role: string }
type AuthResponse = { access_token: string; refresh_token: string }

const nodePresets = [
  { title: 'CSV file', subtitle: 'Read a delimited file', icon: FileSpreadsheet, kind: 'input' },
  { title: 'Remove duplicates', subtitle: 'Keep unique rows', icon: Blocks, kind: 'default' },
  { title: 'Filter rows', subtitle: 'Keep matching records', icon: GitBranch, kind: 'default' },
  { title: 'CSV export', subtitle: 'Write a delimited file', icon: ArrowDownToLine, kind: 'output' },
]

async function apiRequest<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.detail ?? `Request failed (${response.status})`)
  }
  return body as T
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('etl-access-token'))
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [isLoading, setIsLoading] = useState(Boolean(token))
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)
  const [authError, setAuthError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<'overview' | 'workflows' | 'builder'>('overview')
  const [workflow, setWorkflow] = useState<SavedWorkflow | null>(null)
  const [workflowName, setWorkflowName] = useState('Untitled workflow')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const activeWorkspace = workspaces[0]

  useEffect(() => {
    if (!token) return
    Promise.all([
      apiRequest<User>('/api/auth/me', token),
      apiRequest<Workspace[]>('/api/workspaces', token),
      apiRequest<SavedWorkflow[]>('/api/workflows', token),
    ]).then(([nextUser, nextWorkspaces, nextWorkflows]) => {
      setUser(nextUser)
      setWorkspaces(nextWorkspaces)
      setWorkflows(nextWorkflows)
    }).catch((error: unknown) => {
      sessionStorage.removeItem('etl-access-token')
      setToken(null)
      setAuthError(error instanceof Error ? error.message : 'Could not load your workspace')
    }).finally(() => setIsLoading(false))
  }, [token])

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsAuthenticating(true)
    setAuthError('')
    try {
      const path = isRegistering ? '/api/auth/register' : '/api/auth/login'
      const payload = isRegistering
        ? { full_name: authForm.name, email: authForm.email, password: authForm.password }
        : { email: authForm.email, password: authForm.password }
      const auth = await apiRequest<AuthResponse>(path, undefined, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      sessionStorage.setItem('etl-access-token', auth.access_token)
      setIsLoading(true)
      setToken(auth.access_token)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed')
    } finally {
      setIsAuthenticating(false)
    }
  }

  function signOut() {
    sessionStorage.removeItem('etl-access-token')
    setToken(null)
    setUser(null)
    setWorkflows([])
    setWorkspaces([])
    setPage('overview')
  }

  function startWorkflow(existing?: SavedWorkflow) {
    setWorkflow(existing ?? null)
    setWorkflowName(existing?.name ?? 'Untitled workflow')
    setNodes(existing?.graph.nodes ?? [])
    setEdges(existing?.graph.edges ?? [])
    setSelectedNodeId(null)
    setNotice('')
    setPage('builder')
  }

  function addNode(preset: (typeof nodePresets)[number]) {
    const node: Node<FlowData> = {
      id: crypto.randomUUID(),
      type: preset.kind,
      position: { x: 120 + nodes.length * 38, y: 100 + nodes.length * 30 },
      data: { label: preset.title, subtitle: preset.subtitle, config: {} },
    }
    setNodes((current) => [...current, node])
    setSelectedNodeId(node.id)
  }

  function updateSelectedNode(field: 'label' | 'config', key: string, value: string) {
    if (!selectedNodeId) return
    setNodes((current) => current.map((node) => {
      if (node.id !== selectedNodeId) return node
      if (field === 'label') return { ...node, data: { ...node.data, label: value } }
      return { ...node, data: { ...node.data, config: { ...node.data.config, [key]: value } } }
    }))
  }

  async function saveWorkflow() {
    if (!token) return
    if (!activeWorkspace) {
      setNotice('Your account does not have a workspace yet.')
      return
    }
    setNotice('')
    const payload = {
      name: workflowName.trim() || 'Untitled workflow',
      description: workflow?.description ?? null,
      graph: { nodes, edges },
      status: 'draft',
    }
    try {
      const saved = workflow
        ? await apiRequest<SavedWorkflow>(`/api/workflows/${workflow.id}`, token, {
            method: 'PUT', body: JSON.stringify(payload),
          })
        : await apiRequest<SavedWorkflow>(`/api/workflows?workspace_id=${activeWorkspace.id}`, token, {
            method: 'POST', body: JSON.stringify(payload),
          })
      setWorkflow(saved)
      setWorkflowName(saved.name)
      setWorkflows((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setNotice('Workflow saved to your workspace.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save this workflow')
    }
  }

  function checkGraph() {
    if (nodes.length === 0) {
      setNotice('Add a node before checking this workflow.')
      return
    }
    const knownNodeIds = new Set(nodes.map((node) => node.id))
    if (edges.some((edge) => !knownNodeIds.has(edge.source) || !knownNodeIds.has(edge.target))) {
      setNotice('A connection refers to a node that is no longer on the canvas.')
      return
    }
    setNotice('Canvas connections look valid. Data execution is not available yet.')
  }

  if (isLoading) {
    return <main className="loading-screen"><span className="loading-mark"><WorkflowIcon size={20} /></span><p>Opening your workspace</p></main>
  }

  if (!token || !user) {
    return (
      <main className="auth-screen">
        <section className="auth-intro">
          <div className="brand-lockup"><span className="brand-mark"><WorkflowIcon size={19} /></span><span>Universal <b>ETL</b> Studio</span></div>
          <div className="auth-message">
            <p className="eyebrow">DATA WORKFLOWS, MADE VISIBLE</p>
            <h1>Move data with<br /><em>purpose.</em></h1>
            <p className="auth-copy">Build and keep track of your data workflows from one clear workspace.</p>
            <div className="auth-illustration" aria-hidden="true">
              <span className="orbit orbit-a" /><span className="orbit orbit-b" />
              <span className="orbit-node orbit-source"><Database size={18} /></span>
              <span className="orbit-node orbit-transform"><Settings2 size={18} /></span>
              <span className="orbit-node orbit-load"><Cloud size={18} /></span>
              <span className="orbit-line line-a" /><span className="orbit-line line-b" />
            </div>
          </div>
          <p className="auth-footnote">A workspace for the work behind the data.</p>
        </section>
        <section className="auth-panel">
          <form className="auth-form" onSubmit={submitAuth}>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h2>{isRegistering ? 'Create your account' : 'Welcome back'}</h2>
            <p className="form-subtitle">{isRegistering ? 'Start with a workspace of your own.' : 'Sign in to continue to your data workflows.'}</p>
            {isRegistering && <label>Full name<input autoComplete="name" required value={authForm.name} onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })} placeholder="Your name" /></label>}
            <label>Email address<input autoComplete="email" type="email" required value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} placeholder="name@company.com" /></label>
            <label>Password<input autoComplete={isRegistering ? 'new-password' : 'current-password'} type="password" minLength={8} required value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} placeholder="At least 8 characters" /></label>
            {authError && <p className="form-error" role="alert">{authError}</p>}
            <button className="primary-button auth-submit" type="submit" disabled={isAuthenticating}>
              {isAuthenticating ? 'Please wait...' : isRegistering ? 'Create account' : 'Sign in'} <ArrowRight size={16} />
            </button>
            <p className="auth-switch">{isRegistering ? 'Already have an account?' : 'New to the studio?'} <button type="button" onClick={() => { setIsRegistering(!isRegistering); setAuthError('') }}>{isRegistering ? 'Sign in' : 'Create an account'}</button></p>
            <p className="security-note"><LockKeyhole size={13} /> Your account is managed by this workspace API.</p>
          </form>
        </section>
      </main>
    )
  }

  const pageTitle = page === 'overview' ? 'Overview' : page === 'workflows' ? 'Workflows' : 'Workflow builder'
  const totalDrafts = workflows.filter((item) => item.status === 'draft').length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-mark"><WorkflowIcon size={18} /></span><span>Universal <b>ETL</b> Studio</span></div>
        <button className="workspace-switcher" type="button" title={activeWorkspace?.name ?? 'Workspace'}>
          <span className="workspace-avatar">{activeWorkspace?.name?.slice(0, 1).toUpperCase() ?? 'W'}</span>
          <span className="workspace-meta"><small>WORKSPACE</small><strong>{activeWorkspace?.name ?? 'My workspace'}</strong></span><ChevronDown size={15} />
        </button>
        <p className="nav-caption">STUDIO</p>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={page === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('overview')}><LayoutDashboard size={17} /> Overview</button>
          <button className={page === 'workflows' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('workflows')}><WorkflowIcon size={17} /> Workflows <span className="nav-count">{workflows.length}</span></button>
          <button className={page === 'builder' ? 'nav-item active' : 'nav-item'} onClick={() => startWorkflow()}><Blocks size={17} /> Workflow builder</button>
        </nav>
        <p className="nav-caption nav-caption-spaced">MANAGE</p>
        <nav className="side-nav" aria-label="Coming soon">
          <button className="nav-item nav-disabled" title="Coming soon" disabled><Database size={17} /> Connections <span className="soon-label">Soon</span></button>
          <button className="nav-item nav-disabled" title="Coming soon" disabled><Activity size={17} /> Execution history <span className="soon-label">Soon</span></button>
          <button className="nav-item nav-disabled" title="Coming soon" disabled><Clock3 size={17} /> Schedules <span className="soon-label">Soon</span></button>
          <button className="nav-item nav-disabled" title="Coming soon" disabled><CircleHelp size={17} /> Data quality <span className="soon-label">Soon</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="api-status"><span className="status-dot" /> API connected</div>
          <div className="user-card"><span className="user-avatar">{user.full_name.slice(0, 1).toUpperCase()}</span><span className="user-meta"><strong>{user.full_name}</strong><small>{user.email}</small></span><button aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={16} /></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Studio</span><ArrowRight size={13} /><strong>{pageTitle}</strong></div>
          <div className="topbar-actions"><span className="environment-pill"><span /> Local workspace</span><button className="icon-button" title="Search is coming soon" aria-label="Search" disabled><Search size={17} /></button><button className="icon-button" title="Settings are coming soon" aria-label="Settings" disabled><Settings2 size={17} /></button></div>
        </header>

        {page === 'overview' && <section className="content-page overview-page">
          <div className="page-heading"><div><p className="eyebrow">YOUR DATA WORKSPACE</p><h1>Good to have you, {user.full_name.split(' ')[0]}.</h1><p>Here’s what’s in your workspace today.</p></div><button className="primary-button" onClick={() => startWorkflow()}><Plus size={17} /> New workflow</button></div>
          <div className="summary-grid">
            <article className="summary-card summary-primary"><span className="summary-icon"><WorkflowIcon size={17} /></span><p>Saved workflows</p><strong>{workflows.length}</strong><small>In this workspace</small></article>
            <article className="summary-card"><span className="summary-icon green"><Check size={17} /></span><p>Drafts</p><strong>{totalDrafts}</strong><small>Ready for configuration</small></article>
            <article className="summary-card summary-note"><span className="summary-icon coral"><Activity size={17} /></span><p>Execution activity</p><strong className="not-enabled">Not enabled</strong><small>Execution engine is not available yet</small></article>
          </div>
          <div className="section-heading"><div><h2>Recent workflows</h2><p>Your latest saved workflow designs</p></div><button className="text-button" onClick={() => setPage('workflows')}>All workflows <ArrowRight size={15} /></button></div>
          <WorkflowTable workflows={workflows.slice(0, 5)} onOpen={startWorkflow} />
          <div className="next-step-band"><span className="next-step-icon"><Braces size={20} /></span><div><strong>Start by designing a workflow</strong><p>Add source, transform, and destination nodes, then save your graph to this workspace.</p></div><button className="secondary-button" onClick={() => startWorkflow()}>Open builder <ArrowRight size={15} /></button></div>
        </section>}

        {page === 'workflows' && <section className="content-page workflows-page">
          <div className="page-heading"><div><p className="eyebrow">WORKSPACE ASSETS</p><h1>Workflows</h1><p>Saved workflow designs for {activeWorkspace?.name ?? 'your workspace'}.</p></div><button className="primary-button" onClick={() => startWorkflow()}><Plus size={17} /> New workflow</button></div>
          <WorkflowTable workflows={workflows} onOpen={startWorkflow} />
        </section>}

        {page === 'builder' && <section className="builder-page">
          <div className="builder-toolbar"><div className="builder-title"><button className="back-button" onClick={() => setPage('workflows')} title="Back to workflows"><ArrowLeft size={17} /></button><input aria-label="Workflow name" value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} /><span className="draft-tag">Draft</span></div><div className="builder-actions"><button className="secondary-button" onClick={checkGraph}><Check size={15} /> Check graph</button><button className="primary-button" onClick={() => void saveWorkflow()}><Check size={16} /> Save workflow</button></div></div>
          {notice && <div className="notice-bar" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
          <div className="builder-workspace">
            <aside className="node-library"><div className="panel-heading"><p className="eyebrow">BUILD</p><h2>Node library</h2><p>Choose a node to add it to the canvas.</p></div><p className="node-category">FILES</p>{nodePresets.map((preset) => { const Icon = preset.icon; return <button className="node-option" key={preset.title} onClick={() => addNode(preset)}><span className="node-option-icon"><Icon size={16} /></span><span><strong>{preset.title}</strong><small>{preset.subtitle}</small></span><Plus size={15} className="node-add-icon" /></button> })}<div className="library-footnote"><CircleHelp size={14} /><span>Database and API connectors are coming soon.</span></div></aside>
            <div className="flow-canvas"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => setEdges((current) => addEdge(connection, current))} onNodeClick={(_, node) => setSelectedNodeId(node.id)} onPaneClick={() => setSelectedNodeId(null)} fitView deleteKeyCode={['Backspace', 'Delete']}><Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#cbd6d1" /><Controls position="bottom-left" /><MiniMap position="bottom-right" pannable zoomable /></ReactFlow>{nodes.length === 0 && <div className="canvas-empty"><span><GitBranch size={21} /></span><strong>Your canvas is ready</strong><p>Add a node from the library to start laying out your workflow.</p></div>}</div>
            <aside className="config-panel"><div className="panel-heading"><p className="eyebrow">CONFIGURATION</p><h2>{selectedNode ? 'Node settings' : 'Canvas details'}</h2><p>{selectedNode ? 'Edit the selected node.' : 'Select a node to see its settings.'}</p></div>{selectedNode ? <div className="config-fields"><label>Node name<input value={selectedNode.data.label} onChange={(event) => updateSelectedNode('label', '', event.target.value)} /></label><div className="config-kind"><span className="status-dot" />{selectedNode.type === 'input' ? 'Source node' : selectedNode.type === 'output' ? 'Destination node' : 'Transform node'}</div><p className="config-help">{selectedNode.data.subtitle}</p><label>Notes<textarea rows={4} value={selectedNode.data.config.notes ?? ''} onChange={(event) => updateSelectedNode('config', 'notes', event.target.value)} placeholder="Optional setup notes" /></label><button className="remove-node" onClick={() => { setNodes((current) => current.filter((node) => node.id !== selectedNode.id)); setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id)); setSelectedNodeId(null) }}><X size={15} /> Remove node</button></div> : <div className="canvas-stats"><div><span>Nodes</span><strong>{nodes.length}</strong></div><div><span>Connections</span><strong>{edges.length}</strong></div><div className="config-help">This editor saves the graph structure. Running data through it is not enabled yet.</div></div>}</aside>
          </div>
        </section>}
      </main>
    </div>
  )
}

function WorkflowTable({ workflows, onOpen }: { workflows: SavedWorkflow[]; onOpen: (workflow: SavedWorkflow) => void }) {
  if (workflows.length === 0) {
    return <div className="empty-table"><span className="empty-icon"><WorkflowIcon size={20} /></span><strong>No workflows saved yet</strong><p>Your saved workflow designs will show up here.</p></div>
  }
  return <div className="workflow-table-wrap"><table className="workflow-table"><thead><tr><th>Workflow</th><th>Status</th><th>Workspace ID</th><th aria-label="Open" /></tr></thead><tbody>{workflows.map((item) => <tr key={item.id}><td><span className="table-workflow-icon"><WorkflowIcon size={16} /></span><span className="table-workflow-name"><strong>{item.name}</strong><small>{item.description || 'No description'}</small></span></td><td><span className={`status-pill status-${item.status}`}>{item.status}</span></td><td className="workspace-id">{item.workspace_id}</td><td><button className="row-action" title={`Open ${item.name}`} onClick={() => onOpen(item)}><ArrowRight size={16} /></button></td></tr>)}</tbody></table></div>
}

export default App
