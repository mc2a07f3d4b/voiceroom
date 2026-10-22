import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import nodemailer from 'nodemailer'
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import {
  AccessToken,
  EncodedFileOutput,
  EgressClient,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk'

const required = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']
const missing = required.filter((key) => !process.env[key])
if (missing.length) throw new Error(`Missing required server configuration: ${missing.join(', ')}`)

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT,
  })
}

const db = getFirestore()
const firebaseAuth = getAuth()
const livekitHttpUrl = process.env.LIVEKIT_URL.replace(/^ws/, 'http')
const roomService = new RoomServiceClient(livekitHttpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
const egressClient = new EgressClient(livekitHttpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
const s3Client = process.env.RECORDING_S3_REGION && process.env.RECORDING_S3_ACCESS_KEY && process.env.RECORDING_S3_SECRET_KEY
  ? new S3Client({
      region: process.env.RECORDING_S3_REGION,
      credentials: {
        accessKeyId: process.env.RECORDING_S3_ACCESS_KEY,
        secretAccessKey: process.env.RECORDING_S3_SECRET_KEY,
      },
    })
  : null
const gmailSettings = {
  user: process.env.GMAIL_USER,
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
}
const missingGmailSettings = Object.entries({
  GMAIL_USER: gmailSettings.user,
  GOOGLE_OAUTH_CLIENT_ID: gmailSettings.clientId,
  GOOGLE_OAUTH_CLIENT_SECRET: gmailSettings.clientSecret,
  GOOGLE_OAUTH_REFRESH_TOKEN: gmailSettings.refreshToken,
})
  .filter(([, value]) => !value)
  .map(([name]) => name)
const mailer = missingGmailSettings.length
  ? null
  : nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        ...gmailSettings,
      },
    })
const gmailFromName = process.env.GMAIL_FROM_NAME || 'Gather'
const appUrl = (process.env.APP_URL || process.env.APP_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '')
const app = express()

const egressStatusNames = new Map([
  [0, 'starting'],
  [1, 'active'],
  [2, 'ending'],
  [3, 'complete'],
  [4, 'failed'],
  [5, 'aborted'],
  [6, 'limit-reached'],
])
const terminalEgressStatuses = new Set([3, 4, 5, 6])

function maskEmail(email) {
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return '[invalid email]'
  return `${localPart.slice(0, 1)}***@${domain}`
}

function serializeEgressValue(value) {
  return typeof value === 'bigint' ? value.toString() : value
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function invitationTokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function sendInvitationEmail({ email, event, inviterName, invitationUrl, isNewUser }) {
  if (!mailer) {
    throw new HttpError(503, `Invitation email is not configured. Set ${missingGmailSettings.join(', ')} on the API server.`)
  }

  const safeTitle = escapeHtml(event.title)
  const safeInviter = escapeHtml(inviterName)
  const safeUrl = escapeHtml(invitationUrl)
  const subject = isNewUser
    ? `${inviterName} invited you to Gather`
    : `You're invited to ${event.title}`
  const actionText = isNewUser ? 'Create your free account' : 'View gathering'
  const text = `${inviterName} invited you to "${event.title}". ${isNewUser ? 'Create a Gather account to accept the invitation.' : 'Sign in to Gather to view the event.'}\n\n${invitationUrl}`
  const result = await mailer.sendMail({
    from: { name: gmailFromName, address: gmailSettings.user },
    to: email,
    subject,
    html: `<main style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#202116"><p style="color:#607c2e;font-size:12px;font-weight:bold;letter-spacing:2px">GATHER</p><h1 style="font-size:28px">You’re invited.</h1><p>${safeInviter} invited you to <strong>${safeTitle}</strong>.</p><p>${isNewUser ? 'Create a Gather account to accept the invitation and join the conversation.' : 'Sign in to Gather to see the event and join the conversation.'}</p><p style="margin:28px 0"><a href="${safeUrl}" style="background:#d1f17a;border-radius:6px;color:#161911;display:inline-block;padding:13px 18px;text-decoration:none;font-weight:bold">${actionText}</a></p><p style="color:#777;font-size:12px">Audio only. No camera required.</p></main>`,
    text,
  })
  const acceptedRecipients = (result.accepted || []).map((recipient) => recipient.toLowerCase())
  if (!acceptedRecipients.includes(email)) {
    throw new Error(`Gmail SMTP did not accept invitation email for ${maskEmail(email)}.`)
  }
  return result.messageId
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function summarizeEgress(egress) {
  return {
    egressId: egress.egressId,
    roomName: egress.roomName,
    status: egressStatusNames.get(egress.status) || `unknown(${egress.status})`,
    error: egress.error || null,
    startedAt: serializeEgressValue(egress.startedAt) || null,
    endedAt: serializeEgressValue(egress.endedAt) || null,
    fileResults: (egress.fileResults || []).map((file) => ({
      filename: file.filename || null,
      location: file.location || null,
      size: serializeEgressValue(file.size) || 0,
      duration: serializeEgressValue(file.duration) || 0,
    })),
  }
}

async function saveTerminalEgress(ref, egress) {
  const summary = summarizeEgress(egress)
  const eventSnapshot = await ref.get()
  const event = eventSnapshot.data()
  const outputPath = event?.egressId === egress.egressId ? event.recordingOutputPath : null
  const completedFiles = egress.status === 3
    ? summary.fileResults.map((file) => ({
        egressId: egress.egressId,
        filename: file.filename ? basename(file.filename) : outputPath ? basename(outputPath) : 'recording.ogg',
        storageKey: outputPath,
        size: file.size,
        duration: file.duration,
        createdAt: Date.now(),
      })).filter((file) => file.storageKey)
    : []
  await ref.update({
    recordingStatus: egress.status === 3 ? 'stopped' : 'failed',
    lastEgressId: egress.egressId,
    egressId: FieldValue.delete(),
    recordingOutputPath: FieldValue.delete(),
    recordingError: egress.error || FieldValue.delete(),
    ...(completedFiles.length ? { recordingFiles: FieldValue.arrayUnion(...completedFiles) } : {}),
    recordingFinishedAt: FieldValue.serverTimestamp(),
  })
  console.info('[recording] Egress finalized:', JSON.stringify(summary))
}

async function monitorEgressUntilFinal(ref, egressId) {
  const maxAttempts = 24
  let lastStatus

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const [egress] = await egressClient.listEgress({ egressId })
      if (!egress) {
        console.warn('[recording] Egress job was not returned by LiveKit while awaiting final status:', egressId)
      } else {
        if (egress.status !== lastStatus) {
          console.info('[recording] Egress status:', JSON.stringify(summarizeEgress(egress)))
          lastStatus = egress.status
        }
        if (terminalEgressStatuses.has(egress.status)) {
          await saveTerminalEgress(ref, egress)
          return
        }
      }
    } catch (error) {
      console.error('[recording] Failed to poll LiveKit Egress status:', JSON.stringify({
        egressId,
        message: error instanceof Error ? error.message : String(error),
      }))
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }

  console.warn('[recording] Timed out waiting for Egress final status; egressId remains on the event for diagnosis:', egressId)
}

app.use(helmet())
app.use(cors({ origin: process.env.APP_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '32kb' }))

app.use('/api', async (req, _res, next) => {
  const authorization = req.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return next(new HttpError(401, 'Sign in to continue.'))
  try {
    req.user = await firebaseAuth.verifyIdToken(authorization.slice('Bearer '.length))
    return next()
  } catch {
    return next(new HttpError(401, 'Your sign-in has expired. Please sign in again.'))
  }
})

async function getEvent(req) {
  const snapshot = await db.collection('events').doc(req.params.eventId).get()
  if (!snapshot.exists) throw new HttpError(404, 'Gathering not found.')
  const event = snapshot.data()
  if (!event.memberUids?.includes(req.user.uid)) throw new HttpError(403, 'You are not invited to this gathering.')
  return { ref: snapshot.ref, data: event }
}

app.post('/api/events/:eventId/token', async (req, res) => {
  const { data: event } = await getEvent(req)
  const profile = await db.collection('users').doc(req.user.uid).get()
  const displayName = profile.data()?.displayName || req.user.name || req.user.email || 'Gather guest'
  const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: req.user.uid,
    name: displayName,
    ttl: '2h',
  })
  accessToken.addGrant({
    roomJoin: true,
    room: req.params.eventId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE],
  })
  res.json({ token: await accessToken.toJwt(), serverUrl: process.env.LIVEKIT_URL, name: event.title })
})

app.post('/api/events/:eventId/invite', async (req, res) => {
  const { ref, data: event } = await getEvent(req)
  if (!event.moderatorUids?.includes(req.user.uid)) throw new HttpError(403, 'Only a moderator can invite people.')
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.')
  if (!mailer) {
    throw new HttpError(503, `Invitation email is not configured. Set ${missingGmailSettings.join(', ')} on the API server.`)
  }

  console.info('[invite] Looking up Gather account for event invitation:', JSON.stringify({
    eventId: req.params.eventId,
    email: maskEmail(email),
  }))
  let authUser = null
  try {
    authUser = await firebaseAuth.getUserByEmail(email)
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error
  }
  const inviterSnapshot = await db.collection('users').doc(req.user.uid).get()
  const inviterName = inviterSnapshot.data()?.displayName || req.user.name || 'A Gather host'
  const isNewUser = !authUser
  let invitationUrl
  let invitationRef

  if (isNewUser) {
    console.info('[invite] No Firebase Authentication account found; creating a signup invitation.', JSON.stringify({
      eventId: req.params.eventId,
      email: maskEmail(email),
    }))
    const token = randomBytes(32).toString('hex')
    invitationRef = db.collection('invitations').doc(invitationTokenHash(token))
    await invitationRef.set({
      eventId: req.params.eventId,
      email,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    invitationUrl = `${appUrl}/?invite=${encodeURIComponent(token)}`
  } else {
    invitationUrl = `${appUrl}/?event=${encodeURIComponent(req.params.eventId)}`
  }

  let emailId
  try {
    emailId = await sendInvitationEmail({ email, event, inviterName, invitationUrl, isNewUser })
  } catch (error) {
    if (invitationRef) {
      await invitationRef.delete().catch((cleanupError) => {
        console.error('[invite] Failed to remove unused signup invitation:', cleanupError)
      })
    }
    console.error('[invite] Email delivery failed:', JSON.stringify({
      eventId: req.params.eventId,
      email: maskEmail(email),
      error: error instanceof Error ? error.message : String(error),
    }))
    if (error instanceof HttpError) throw error
    throw new HttpError(502, 'The invitation could not be emailed. Check the API server logs and Gmail OAuth configuration.')
  }

  if (!isNewUser) {
    const profileSnapshot = await db.collection('users').doc(authUser.uid).get()
    const profile = profileSnapshot.data()
    await ref.update({
      memberUids: FieldValue.arrayUnion(authUser.uid),
      invitees: FieldValue.arrayUnion({ uid: authUser.uid, email, name: profile?.displayName || '' }),
    })
  }

  console.info('[invite] Invitation email accepted by Gmail SMTP:', JSON.stringify({
    eventId: req.params.eventId,
    email: maskEmail(email),
    recipientHasAccount: !isNewUser,
    emailId,
  }))
  res.json({ invited: true, emailSent: true, recipientHasAccount: !isNewUser })
})

app.post('/api/invitations/accept', async (req, res) => {
  const token = typeof req.body.inviteToken === 'string' ? req.body.inviteToken : ''
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, 'This invitation link is invalid.')
  const invitationRef = db.collection('invitations').doc(invitationTokenHash(token))
  const uid = req.user.uid
  const email = req.user.email?.trim().toLowerCase()
  if (!email) throw new HttpError(400, 'Your account must have an email address to accept this invitation.')

  const result = await db.runTransaction(async (transaction) => {
    const invitationSnapshot = await transaction.get(invitationRef)
    if (!invitationSnapshot.exists) throw new HttpError(404, 'This invitation has expired or is invalid.')
    const invitation = invitationSnapshot.data()
    if (invitation.email !== email) throw new HttpError(403, 'Sign in or sign up with the email address this invitation was sent to.')
    if (invitation.status === 'accepted' && invitation.acceptedBy === uid) {
      return { eventId: invitation.eventId, alreadyAccepted: true }
    }
    if (invitation.status !== 'pending' || !(invitation.expiresAt instanceof Timestamp) || invitation.expiresAt.toMillis() <= Date.now()) {
      throw new HttpError(410, 'This invitation has expired.')
    }

    const eventRef = db.collection('events').doc(invitation.eventId)
    const eventSnapshot = await transaction.get(eventRef)
    if (!eventSnapshot.exists) throw new HttpError(404, 'The gathering for this invitation no longer exists.')
    const event = eventSnapshot.data()
    const invitee = { uid, email, name: req.user.name || '' }
    transaction.update(eventRef, {
      memberUids: FieldValue.arrayUnion(uid),
      invitees: FieldValue.arrayUnion(invitee),
    })
    transaction.update(invitationRef, {
      status: 'accepted',
      acceptedBy: uid,
      acceptedAt: FieldValue.serverTimestamp(),
    })
    return { eventId: invitation.eventId, eventTitle: event.title, alreadyAccepted: false }
  })
  res.json({ accepted: true, ...result })
})

app.post('/api/events/:eventId/recordings/:egressId/playback', async (req, res) => {
  const { data: event } = await getEvent(req)
  if (!s3Client || !process.env.RECORDING_S3_BUCKET) {
    throw new HttpError(503, 'Recording playback storage is not configured on the API server.')
  }
  const recording = event.recordingFiles?.find((file) => file.egressId === req.params.egressId)
  if (!recording?.storageKey || !recording.storageKey.startsWith(`gather/${req.params.eventId}/`)) {
    throw new HttpError(404, 'This recording file is not available.')
  }
  const command = new GetObjectCommand({
    Bucket: process.env.RECORDING_S3_BUCKET,
    Key: recording.storageKey,
    ResponseContentDisposition: 'inline',
  })
  const playbackUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 })
  res.json({ url: playbackUrl, expiresIn: 900, filename: recording.filename })
})

app.post('/api/events/:eventId/moderators', async (req, res) => {
  const { ref, data: event } = await getEvent(req)
  if (!event.moderatorUids?.includes(req.user.uid)) throw new HttpError(403, 'Only a moderator can nominate another moderator.')
  const participantUid = typeof req.body.participantUid === 'string' ? req.body.participantUid : ''
  if (!event.memberUids.includes(participantUid)) throw new HttpError(400, 'The nominated person must be a member of this gathering.')
  await ref.update({ moderatorUids: FieldValue.arrayUnion(participantUid) })
  res.json({ promoted: true })
})

app.post('/api/events/:eventId/mute', async (req, res) => {
  const { data: event } = await getEvent(req)
  if (!event.moderatorUids?.includes(req.user.uid)) throw new HttpError(403, 'Only a moderator can change another person’s microphone.')
  const targetUid = typeof req.body.targetUid === 'string' ? req.body.targetUid : ''
  const muted = req.body.muted
  if (!event.memberUids.includes(targetUid) || targetUid === req.user.uid || typeof muted !== 'boolean') {
    throw new HttpError(400, 'Choose another member and a valid mute state.')
  }
  const participants = await roomService.listParticipants(req.params.eventId)
  const target = participants.find((participant) => participant.identity === targetUid)
  if (!target) throw new HttpError(404, 'That person is no longer in the voice room.')
  const audioTracks = target.tracks.filter((track) => track.type === TrackType.AUDIO)
  if (!audioTracks.length) throw new HttpError(409, 'That person has no published microphone track.')
  await Promise.all(audioTracks.map((track) => roomService.mutePublishedTrack(
    req.params.eventId,
    targetUid,
    track.sid,
    muted,
  )))
  res.json({ muted })
})

app.post('/api/events/:eventId/recording/start', async (req, res) => {
  const { ref, data: event } = await getEvent(req)
  if (!event.moderatorUids?.includes(req.user.uid)) throw new HttpError(403, 'Only a moderator can start a recording.')
  if (!process.env.RECORDING_S3_BUCKET || !process.env.RECORDING_S3_REGION ||
      !process.env.RECORDING_S3_ACCESS_KEY || !process.env.RECORDING_S3_SECRET_KEY) {
    console.error('[recording] Start rejected: S3 destination settings are incomplete.', JSON.stringify({
      bucketConfigured: Boolean(process.env.RECORDING_S3_BUCKET),
      regionConfigured: Boolean(process.env.RECORDING_S3_REGION),
      accessKeyConfigured: Boolean(process.env.RECORDING_S3_ACCESS_KEY),
      secretKeyConfigured: Boolean(process.env.RECORDING_S3_SECRET_KEY),
    }))
    throw new HttpError(503, 'Recording storage is not configured. Add the S3 settings to the server environment.')
  }
  if (['recording', 'stopping'].includes(event.recordingStatus) && event.egressId) {
    throw new HttpError(409, 'A recording is already active or finalizing for this gathering.')
  }
  const outputPath = `gather/${req.params.eventId}/${Date.now()}.ogg`
  console.info('[recording] Starting audio-only Egress:', JSON.stringify({
    roomName: req.params.eventId,
    bucket: process.env.RECORDING_S3_BUCKET,
    region: process.env.RECORDING_S3_REGION,
    outputPath,
  }))
  const output = new EncodedFileOutput({
    filepath: outputPath,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: process.env.RECORDING_S3_ACCESS_KEY,
        secret: process.env.RECORDING_S3_SECRET_KEY,
        bucket: process.env.RECORDING_S3_BUCKET,
        region: process.env.RECORDING_S3_REGION,
      }),
    },
  })
  const egress = await egressClient.startRoomCompositeEgress(req.params.eventId, output, { audioOnly: true })
  console.info('[recording] LiveKit accepted Egress start:', JSON.stringify(summarizeEgress(egress)))
  try {
    await ref.update({
      recordingStatus: 'recording',
      egressId: egress.egressId,
      recordingOutputPath: outputPath,
      recordingStartedAt: FieldValue.serverTimestamp(),
      recordingError: FieldValue.delete(),
      recordingFiles: FieldValue.delete(),
    })
  } catch (error) {
    console.error('[recording] Egress started but its ID could not be saved to Firestore:', JSON.stringify({
      egressId: egress.egressId,
      roomName: req.params.eventId,
      message: error instanceof Error ? error.message : String(error),
    }))
    throw error
  }
  res.json({ recording: true })
})

app.post('/api/events/:eventId/recording/stop', async (req, res) => {
  const { ref, data: event } = await getEvent(req)
  if (!event.moderatorUids?.includes(req.user.uid)) throw new HttpError(403, 'Only a moderator can stop a recording.')
  if (!event.egressId) throw new HttpError(409, 'There is no active recording to stop.')
  const egressId = event.egressId
  console.info('[recording] Stop requested:', JSON.stringify({ roomName: req.params.eventId, egressId }))
  let egress
  try {
    egress = await egressClient.stopEgress(egressId)
  } catch (error) {
    console.error('[recording] Failed to stop Egress:', JSON.stringify({
      roomName: req.params.eventId,
      egressId,
      message: error instanceof Error ? error.message : String(error),
    }))
    throw error
  }
  console.info('[recording] LiveKit accepted Egress stop:', JSON.stringify(summarizeEgress(egress)))
  try {
    await ref.update({ recordingStatus: 'stopping' })
  } catch (error) {
    console.error('[recording] Egress stop was accepted but Firestore status update failed:', JSON.stringify({
      egressId,
      roomName: req.params.eventId,
      message: error instanceof Error ? error.message : String(error),
    }))
    throw error
  }
  res.json({ recording: 'stopping' })
  void monitorEgressUntilFinal(ref, egressId)
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }))

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
  console.error('API request failed:', error)
  return res.status(500).json({ error: 'The request could not be completed. Please try again.' })
})

const port = Number(process.env.PORT || 3001)
app.listen(port, () => console.log(`Gather API listening on http://localhost:${port}`))
