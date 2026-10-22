import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useParticipants,
  useSpeakingParticipants,
} from '@livekit/components-react'
import { auth, db } from './firebase'
import { apiRequest } from './api'

type VoiceEvent = {
  id: string
  title: string
  description?: string
  startsAt: number
  durationMinutes: number
  createdBy: string
  moderatorUids: string[]
  memberUids: string[]
  invitees?: { uid: string; email: string; name: string }[]
  recordingStatus?: 'recording' | 'stopping' | 'stopped' | 'failed'
  recordingFiles?: RecordingFile[]
}

type RecordingFile = {
  egressId: string
  filename: string
  storageKey: string
  size: string
  duration: string
  createdAt: number
}

type RoomCredentials = { token: string; serverUrl: string; name: string }

function getAuthErrorMessage(issue: unknown) {
  const code = typeof issue === 'object' && issue !== null && 'code' in issue
    ? String(issue.code)
    : ''

  if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
    return 'Firebase Authentication is not configured for this project. In Firebase Console, open Authentication → Sign-in method and enable Email/Password. Confirm your VITE_FIREBASE_* values are from the same Firebase project, then restart Vite.'
  }

  return issue instanceof Error ? issue.message : 'Unable to sign in.'
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

function formatBytes(value: string) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function maskEmail(email: string) {
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return '[invalid email]'
  return `${localPart.slice(0, 1)}***@${domain}`
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [events, setEvents] = useState<VoiceEvent[]>([])
  const [selected, setSelected] = useState<VoiceEvent | null>(null)
  const [room, setRoom] = useState<RoomCredentials | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const acceptedInviteToken = useRef('')

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser)
    setAuthReady(true)
  }), [])

  useEffect(() => {
    if (!user) {
      setEvents([])
      setSelected(null)
      return
    }
    return onSnapshot(
      query(collection(db, 'events'), where('memberUids', 'array-contains', user.uid)),
      (snapshot) => {
        const nextEvents = snapshot.docs.map((item) => {
          const data = item.data()
          return {
            id: item.id,
            ...data,
            startsAt: data.startsAt instanceof Timestamp ? data.startsAt.toMillis() : data.startsAt,
          } as VoiceEvent
        })
          .sort((a, b) => a.startsAt - b.startsAt)
        setEvents(nextEvents)
        setSelected((current) => current ? nextEvents.find((item) => item.id === current.id) ?? null : null)
      },
      (error) => setNotice(`Couldn't load your events: ${error.message}`),
    )
  }, [user])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invite')
    if (!user || !token || acceptedInviteToken.current === token) return
    acceptedInviteToken.current = token
    void apiRequest<{ eventId: string }>(user, '/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ inviteToken: token }),
    }).then(({ eventId }) => {
      window.history.replaceState({}, '', window.location.pathname)
      setNotice('Invitation accepted. The gathering is now in your event list.')
      const invitedEvent = events.find((event) => event.id === eventId)
      if (invitedEvent) setSelected(invitedEvent)
    }).catch((error: unknown) => {
      acceptedInviteToken.current = ''
      setNotice(error instanceof Error ? error.message : 'Could not accept the invitation.')
    })
  }, [user, events])

  useEffect(() => {
    const eventId = new URLSearchParams(window.location.search).get('event')
    if (!user || !eventId) return
    const invitedEvent = events.find((event) => event.id === eventId)
    if (!invitedEvent) return
    setSelected(invitedEvent)
    window.history.replaceState({}, '', window.location.pathname)
  }, [user, events])

  const upcoming = useMemo(() => events.filter(
    (item) => item.startsAt + item.durationMinutes * 60_000 > Date.now(),
  ), [events])

  async function createEvent(form: { title: string; description: string; date: string; time: string; duration: number }) {
    if (!user) return
    setBusy(true)
    setNotice('')
    try {
      const startsAt = new Date(`${form.date}T${form.time}`).getTime()
      if (!Number.isFinite(startsAt)) throw new Error('Choose a valid date and time.')
      const reference = await addDoc(collection(db, 'events'), {
        title: form.title.trim(),
        description: form.description.trim(),
        startsAt: Timestamp.fromMillis(startsAt),
        durationMinutes: form.duration,
        createdBy: user.uid,
        moderatorUids: [user.uid],
        memberUids: [user.uid],
        invitees: [{ uid: user.uid, email: user.email ?? '', name: user.displayName ?? '' }],
        createdAt: serverTimestamp(),
      })
      setNotice('Event created. Invite people when you are ready.')
      setSelected({
        id: reference.id,
        title: form.title.trim(),
        description: form.description.trim(),
        startsAt,
        durationMinutes: form.duration,
        createdBy: user.uid,
        moderatorUids: [user.uid],
        memberUids: [user.uid],
        invitees: [{ uid: user.uid, email: user.email ?? '', name: user.displayName ?? '' }],
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create the event.')
    } finally {
      setBusy(false)
    }
  }

  async function enterRoom(event: VoiceEvent) {
    if (!user) return
    setBusy(true)
    setNotice('')
    try {
      const credentials = await apiRequest<RoomCredentials>(user, `/events/${event.id}/token`, { method: 'POST' })
      setSelected(event)
      setRoom(credentials)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start the voice room.')
    } finally {
      setBusy(false)
    }
  }

  async function runEventAction(path: string, body: object, success: string): Promise<boolean> {
    if (!user || !selected) return false
    setBusy(true)
    setNotice('')
    const isInvite = path === 'invite'
    if (isInvite) {
      const email = 'email' in body && typeof body.email === 'string' ? body.email : ''
      console.info('[invite] Sending event invitation request:', {
        eventId: selected.id,
        email: maskEmail(email),
      })
    }
    try {
      const result = await apiRequest<{ emailSent?: boolean; recipientHasAccount?: boolean }>(user, `/events/${selected.id}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setNotice(isInvite
        ? result.emailSent
          ? result.recipientHasAccount
            ? 'Invitation email accepted for delivery. The user was added to the gathering.'
            : 'Signup invitation email accepted for delivery.'
          : 'The invitation request completed.'
        : success)
      if (isInvite) console.info('[invite] Invitation email accepted for delivery.', {
        eventId: selected.id,
        recipientHasAccount: result.recipientHasAccount,
      })
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That action could not be completed.')
      if (isInvite) {
        console.error('[invite] Invite request failed:', {
          eventId: selected.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!authReady) return <div className="loading-screen"><span className="brand-mark">g</span></div>
  if (!user) return <AuthScreen />

  if (room && selected) {
    return (
      <LiveKitRoom
        serverUrl={room.serverUrl}
        token={room.token}
        connect
        audio
        video={false}
        onDisconnected={() => setRoom(null)}
        className="livekit-root"
      >
        <RoomAudioRenderer />
        <VoiceRoom
          event={selected}
          user={user}
          onLeave={() => setRoom(null)}
          onAction={runEventAction}
          busy={busy}
          notice={notice}
        />
      </LiveKitRoom>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => setSelected(null)} aria-label="Gather home">
          <span className="brand-mark">g</span><span>gather<span className="wordmark-period">.</span></span>
        </button>
        <div className="topbar-right">
          <span className="user-chip"><span className="avatar avatar-small">{initials(user.displayName || user.email || '')}</span>{user.displayName || user.email}</span>
          <button className="icon-button" title="Sign out" onClick={() => signOut(auth)} aria-label="Sign out">↗</button>
        </div>
      </header>

      <div className="dashboard">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">YOUR SPACE</p>
            <h1>Make room<br />for a good <span>conversation.</span></h1>
            <p className="subheading">A place to talk, listen, and be together — without the cameras.</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="orbit orbit-one" /><div className="orbit orbit-two" />
            <div className="hero-center"><span>♫</span></div>
            <span className="float-dot dot-a" /><span className="float-dot dot-b" /><span className="float-dot dot-c" />
          </div>
        </section>

        {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

        <section className="workspace-grid">
          <CreateEventCard onCreate={createEvent} busy={busy} />
          <div className="events-panel">
            <div className="section-heading">
              <div><p className="eyebrow">ON THE CALENDAR</p><h2>Your gatherings <span className="count-pill">{upcoming.length}</span></h2></div>
            </div>
            {upcoming.length === 0 ? (
              <div className="empty-state"><span className="empty-icon">◷</span><h3>Nothing on the calendar yet</h3><p>Create a gathering and invite your people.</p></div>
            ) : (
              <div className="event-list">
                {upcoming.map((event) => (
                  <article className={`event-card ${selected?.id === event.id ? 'event-card-selected' : ''}`} key={event.id}>
                    <div className="date-block"><span>{new Date(event.startsAt).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span><strong>{new Date(event.startsAt).getDate()}</strong></div>
                    <div className="event-info"><h3>{event.title}</h3><p>{formatDate(event.startsAt)} <span>·</span> {event.durationMinutes} min</p><div className="event-meta"><span className="tiny-avatar-stack">{event.memberUids.slice(0, 3).map((uid, index) => <span className={`tiny-avatar tone-${index}`} key={uid}>{index === 0 ? initials(event.title) : '·'}</span>)}</span><span>{event.memberUids.length} invited</span></div></div>
                    <button className="event-open" onClick={() => setSelected(event)} aria-label={`Open ${event.title}`}>↗</button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        {selected && <EventDetails event={selected} user={user} onJoin={() => enterRoom(selected)} onAction={runEventAction} busy={busy} onClose={() => setSelected(null)} />}
        <footer>GOOD CONVERSATIONS, NO CAMERAS <span>✳</span></footer>
      </div>
    </main>
  )
}

function AuthScreen() {
  const invitePending = new URLSearchParams(window.location.search).has('invite')
  const [mode, setMode] = useState<'signin' | 'signup'>(invitePending ? 'signup' : 'signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      let signedInUser: User
      if (mode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password)
        await updateProfile(credential.user, { displayName: name.trim() })
        signedInUser = credential.user
      } else {
        const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
        signedInUser = credential.user
      }
      await setDoc(doc(db, 'users', signedInUser.uid), {
        uid: signedInUser.uid,
        email: signedInUser.email?.trim().toLowerCase() ?? '',
        displayName: signedInUser.displayName ?? (mode === 'signup' ? name.trim() : ''),
        updatedAt: serverTimestamp(),
      }, { merge: true })
    } catch (issue) {
      setError(getAuthErrorMessage(issue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-visual">
        <div className="auth-brand"><span className="brand-mark">g</span> gather<span className="wordmark-period">.</span></div>
        <div className="auth-visual-content">
          <div className="sound-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          <p className="eyebrow">A LITTLE CLOSER, FROM ANYWHERE</p>
          <h1>Just voices.<br /><span>Real presence.</span></h1>
          <p>Make space for the people you miss, the ideas you love, and the conversations that matter.</p>
        </div>
        <p className="auth-footnote">No cameras. No pressure. Just come as you are.</p>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <p className="eyebrow">{mode === 'signin' ? 'WELCOME BACK' : 'YOUR PEOPLE ARE HERE'}</p>
          <h2>{mode === 'signin' ? 'Come on in.' : 'Find your voice.'}</h2>
          <p className="auth-caption">{invitePending
            ? 'You have a gathering invitation. Sign in or create an account using the email address it was sent to.'
            : mode === 'signin'
              ? 'Pick up where the conversation left off.'
              : 'Create an account and bring everyone together.'}</p>
          {mode === 'signup' && <label>Your name<input required value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="How should we call you?" /></label>}
          <label>Email address<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" /></label>
          <label>Password<input required minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 6 characters" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary button-full" disabled={busy}>{busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}<span>↗</span></button>
          <p className="auth-switch">{mode === 'signin' ? 'New around here?' : 'Already have an account?'} <button type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError('') }}>{mode === 'signin' ? 'Create an account' : 'Sign in'}</button></p>
        </form>
      </section>
    </main>
  )
}

function CreateEventCard({ onCreate, busy }: { onCreate: (form: { title: string; description: string; date: string; time: string; duration: number }) => void; busy: boolean }) {
  const today = new Date()
  const defaultDate = new Date(today.getTime() - today.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  return (
    <form className="create-card" onSubmit={(event) => {
      event.preventDefault()
      const form = event.currentTarget
      const data = new FormData(form)
      const date = String(data.get('date'))
      const time = String(data.get('time'))
      const dateInput = form.elements.namedItem('date') as HTMLInputElement
      if (new Date(`${date}T${time}`).getTime() < Date.now()) {
        dateInput.setCustomValidity('Choose a future start time.')
        dateInput.reportValidity()
        return
      }
      dateInput.setCustomValidity('')
      onCreate({ title: String(data.get('title')), description: String(data.get('description')), date, time, duration: Number(data.get('duration')) })
    }} onChange={(event) => {
      if (event.target instanceof HTMLInputElement && ['date', 'time'].includes(event.target.name)) {
        event.target.setCustomValidity('')
      }
    }}>
      <div className="card-heading"><span className="heading-icon">✳</span><div><p className="eyebrow">START SOMETHING</p><h2>Host a gathering</h2></div></div>
      <label>What are we getting together for?<input name="title" required maxLength={70} placeholder="Sunday catch-up, book club…" /></label>
      <label>A little more about it <span className="optional">OPTIONAL</span><input name="description" maxLength={180} placeholder="Give everyone a little context" /></label>
      <div className="form-row">
        <label>Date<input type="date" name="date" required min={defaultDate} defaultValue={defaultDate} /></label>
        <label>Time<input type="time" name="time" required defaultValue="18:00" /></label>
      </div>
      <label>How long?<select name="duration" defaultValue="60"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select></label>
      <button className="button button-primary button-full" disabled={busy}>{busy ? 'Creating…' : 'Create gathering'} <span>↗</span></button>
      <p className="card-note">You’ll be the host. Everyone’s welcome to speak.</p>
    </form>
  )
}

function EventDetails({ event, user, onJoin, onAction, busy, onClose }: {
  event: VoiceEvent
  user: User
  onJoin: () => void
  onAction: (path: string, body: object, success: string) => Promise<boolean>
  busy: boolean
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [playbackUrls, setPlaybackUrls] = useState<Record<string, string>>({})
  const [playbackErrors, setPlaybackErrors] = useState<Record<string, string>>({})
  const [loadingRecording, setLoadingRecording] = useState('')
  const isModerator = event.moderatorUids.includes(user.uid)

  async function loadRecording(recording: RecordingFile) {
    setLoadingRecording(recording.egressId)
    setPlaybackErrors((current) => ({ ...current, [recording.egressId]: '' }))
    try {
      const result = await apiRequest<{ url: string }>(
        user,
        `/events/${event.id}/recordings/${encodeURIComponent(recording.egressId)}/playback`,
        { method: 'POST' },
      )
      setPlaybackUrls((current) => ({ ...current, [recording.egressId]: result.url }))
    } catch (error) {
      setPlaybackErrors((current) => ({
        ...current,
        [recording.egressId]: error instanceof Error ? error.message : 'Could not load this recording.',
      }))
    } finally {
      setLoadingRecording('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="event-modal-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">GATHERING DETAILS</p>
        <h2 id="event-modal-title">{event.title}</h2>
        <p className="modal-date">{formatDate(event.startsAt)} <span>·</span> {event.durationMinutes} minutes</p>
        {event.description && <p className="modal-description">{event.description}</p>}
        <div className="detail-rule" />
        <div className="people-heading"><h3>Your people</h3><span>{event.memberUids.length} invited</span></div>
        <div className="member-chips">{event.invitees?.map((person) => <span className="member-chip" key={person.uid}><span className="avatar avatar-small">{initials(person.name || person.email)}</span>{person.name || person.email}{event.moderatorUids.includes(person.uid) && <span className="mod-tag">MOD</span>}</span>)}</div>
        {Boolean(event.recordingFiles?.length) && <section className="recordings-section">
          <div className="people-heading"><h3>Recordings</h3><span>{event.recordingFiles?.length} file{event.recordingFiles?.length === 1 ? '' : 's'}</span></div>
          <div className="recording-list">
            {event.recordingFiles?.map((recording) => (
              <article className="recording-item" key={recording.egressId}>
                <div className="recording-item-heading">
                  <div><h4>{recording.filename}</h4><p>{new Date(recording.createdAt).toLocaleString()} · {formatBytes(recording.size)}</p></div>
                  {!playbackUrls[recording.egressId] && <button className="button button-outline" onClick={() => void loadRecording(recording)} disabled={loadingRecording === recording.egressId}>
                    {loadingRecording === recording.egressId ? 'Loading…' : 'Play'}
                  </button>}
                </div>
                {playbackErrors[recording.egressId] && <p className="form-error" role="alert">{playbackErrors[recording.egressId]}</p>}
                {playbackUrls[recording.egressId] && <>
                  <audio className="recording-audio" controls preload="none" src={playbackUrls[recording.egressId]} />
                  <a className="recording-download" href={playbackUrls[recording.egressId]} target="_blank" rel="noreferrer">Open recording file ↗</a>
                </>}
              </article>
            ))}
          </div>
        </section>}
        {isModerator && <form className="invite-form" onSubmit={async (e) => {
          e.preventDefault()
          const invited = await onAction(
            'invite',
            { email },
            'Added to the gathering. No email was sent; invited users with Gather accounts will see it in their event list.',
          )
          if (invited) setEmail('')
        }}>
          <input type="email" required placeholder="Invite by email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="button button-outline" disabled={busy}>Invite</button>
        </form>}
        {isModerator && Boolean(event.invitees?.length) && <div className="promote-list">
          {event.invitees?.filter((person) => person.uid !== user.uid && !event.moderatorUids.includes(person.uid)).map((person) => (
            <button key={person.uid} disabled={busy} onClick={() => onAction('moderators', { participantUid: person.uid }, `${person.name || person.email} is now a moderator.`)}>Make {person.name || person.email} a moderator</button>
          ))}
        </div>}
        <div className="modal-actions">
          <button className="button button-primary button-full" onClick={onJoin} disabled={busy}>Start / join voice room <span>↗</span></button>
        </div>
        <p className="modal-footnote">Audio only, always. No one needs to turn on a camera.</p>
      </section>
    </div>
  )
}

function VoiceRoom({ event, user, onLeave, onAction, busy, notice }: {
  event: VoiceEvent
  user: User
  onLeave: () => void
  onAction: (path: string, body: object, success: string) => Promise<boolean>
  busy: boolean
  notice: string
}) {
  const participants = useParticipants()
  const speakers = useSpeakingParticipants()
  const { localParticipant, isMicrophoneEnabled, lastMicrophoneError } = useLocalParticipant()
  const [error, setError] = useState('')
  const moderator = event.moderatorUids.includes(user.uid)
  const speakingIds = new Set(speakers.map((participant) => participant.identity))
  async function toggleMic() {
    try {
      const enabled = !isMicrophoneEnabled
      await localParticipant.setMicrophoneEnabled(enabled)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Microphone permission was not granted.')
    }
  }

  async function leave() {
    onLeave()
  }

  return (
    <main className="room-screen">
      <header className="room-topbar">
        <button className="wordmark" onClick={leave}><span className="brand-mark">g</span><span>gather<span className="wordmark-period">.</span></span></button>
        <div className="room-live-label"><span className="live-dot" /> LIVE GATHERING</div>
        <span className="room-scheduled">{formatDate(event.startsAt)}</span>
      </header>
      <section className="room-content">
        <p className="eyebrow">YOU’RE IN A GOOD PLACE</p>
        <h1>{event.title}</h1>
        <p className="room-subtitle">A little less screen. A little more <span>each other.</span></p>
        <div className="room-status"><span className="live-pulse" /> {participants.length} {participants.length === 1 ? 'person' : 'people'} here <i /> {speakers.length ? `${speakers.length} talking` : 'quiet moment'}</div>
        {notice && <div className="notice room-notice" role="status">{notice}</div>}
        {(error || lastMicrophoneError) && <div className="notice room-notice error-notice" role="alert">{error || lastMicrophoneError?.message}</div>}
        <div className="participant-grid">
          {participants.map((participant, index) => {
            const isSpeaking = speakingIds.has(participant.identity)
            const isSelf = participant.identity === user.uid
            const name = participant.name || (isSelf ? user.displayName : 'Guest') || 'Guest'
            const colorIndex = index % 5
            return (
              <article className={`participant-card ${isSpeaking ? 'participant-speaking' : ''}`} key={participant.identity}>
                <div className={`participant-avatar avatar-color-${colorIndex} ${isSpeaking ? 'avatar-speaking' : ''}`}><span>{initials(name)}</span><i className="sound-rings" /></div>
                <h3>{name}{isSelf && <span className="you-tag">YOU</span>}</h3>
                <p>{isSpeaking ? <><span className="speaking-dot" /> Speaking</> : participant.isMicrophoneEnabled ? 'Listening in' : 'Muted'}</p>
                {moderator && !isSelf && <button className="mute-button" disabled={busy} onClick={() => onAction('mute', { targetUid: participant.identity, muted: participant.isMicrophoneEnabled }, participant.isMicrophoneEnabled ? `${name} muted.` : `${name} unmuted.`)}>{participant.isMicrophoneEnabled ? 'Mute' : 'Unmute'}</button>}
              </article>
            )
          })}
          <div className="room-invite-tile"><span>＋</span><p>More voices<br />are welcome</p></div>
        </div>
      </section>
      <div className="room-controls">
        <div className="recording-state">{event.recordingStatus === 'recording'
          ? <><span className="record-dot" /> Recording</>
          : event.recordingStatus === 'stopping'
            ? 'Finalizing recording…'
            : event.recordingStatus === 'failed'
              ? 'Recording failed'
              : 'Audio only'}</div>
        <div className="control-buttons">
          <button className={`mic-control ${isMicrophoneEnabled ? '' : 'mic-muted'}`} onClick={toggleMic} aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}><span>{isMicrophoneEnabled ? '♬' : '⊘'}</span><small>{isMicrophoneEnabled ? 'Mute' : 'Unmute'}</small></button>
          <button className="leave-control" onClick={leave}><span>↗</span> Leave room</button>
        </div>
        <div className="moderator-controls">{moderator && <>
          <span>MODERATOR</span>
          <button
            onClick={() => onAction(
              event.recordingStatus === 'recording' ? 'recording/stop' : 'recording/start',
              {},
              event.recordingStatus === 'recording' ? 'Recording is finalizing; check server logs for the upload result.' : 'Recording started.',
            )}
            disabled={busy || event.recordingStatus === 'stopping'}
          >
            {event.recordingStatus === 'stopping'
              ? 'Finalizing…'
              : event.recordingStatus === 'recording'
                ? 'Stop recording'
                : 'Start recording'}
          </button>
        </>}</div>
      </div>
    </main>
  )
}

export default App
