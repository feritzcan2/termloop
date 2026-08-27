use std::collections::{HashMap, HashSet, VecDeque};
use std::future::IntoFuture;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicBool, Ordering},
};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use termloop_contract::current::{
    ACCESS_PROTOCOL_IDENTITY, AccessAuthenticate, AccessAuthenticated, AccessChallenge,
    AccessChannel, AccessDeviceDto, AccessDeviceScope, AccessEnroll, AccessEnrolled,
    AccessPairChallenge, AccessPairExchange, AccessPaired, AccessPairingInvitationDto,
    AccessProtocolError, AccessScope, AccessStatusDto, CONTRACT_IDENTITY,
};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tokio::time::{Duration, timeout};

use super::AppState;
use super::control::{ClientScope, ConnectionOrigin, RemoteControlCredential, control_socket};
use super::terminal_plane::terminal_socket_remote;

const ACCESS_CONFIG_FILE: &str = "access-plane.json";
const ACCESS_DEVICE_FILE: &str = "access-devices.json";
const ACCESS_FILE_LIMIT: usize = 1024 * 1024;
const DEFAULT_ACCESS_PORT: u16 = 43_717;
const PAIRING_TTL_MS: u64 = 120_000;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HANDSHAKE_MESSAGE: usize = 16 * 1024;
const MAX_DEVICE_REGISTRATION_ATTEMPTS_PER_MINUTE: usize = 60;
const MAX_ACTIVE_PAIRING_INVITATIONS: usize = 128;
const MAX_PAIRED_DEVICES: usize = 1_024;
const LAST_SEEN_PERSIST_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::app) enum RemoteScope {
    Full,
    ReadOnly,
}

impl RemoteScope {
    fn protocol(self) -> AccessDeviceScope {
        match self {
            Self::Full => AccessDeviceScope::Full,
            Self::ReadOnly => AccessDeviceScope::ReadOnly,
        }
    }

    pub(in crate::app) fn allows_terminal_input(self) -> bool {
        self == Self::Full
    }
}

impl From<&AccessScope> for RemoteScope {
    fn from(value: &AccessScope) -> Self {
        match value {
            AccessScope::Full => Self::Full,
            AccessScope::ReadOnly => Self::ReadOnly,
        }
    }
}

#[derive(Clone)]
pub(in crate::app) struct AccessPlane {
    inner: Arc<AccessPlaneInner>,
}

struct AccessPlaneInner {
    config_path: PathBuf,
    devices_path: PathBuf,
    config: StdMutex<AccessConfig>,
    devices: StdMutex<AccessDeviceFile>,
    invitations: StdMutex<HashMap<[u8; 32], PairingInvitation>>,
    device_registration_attempts: StdMutex<VecDeque<u64>>,
    revocations: broadcast::Sender<String>,
    management: tokio::sync::Mutex<()>,
    lifecycle: tokio::sync::Mutex<Option<AccessListener>>,
    listening: AtomicBool,
    last_error: StdMutex<Option<String>>,
}

struct AccessListener {
    port: u16,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessConfig {
    version: u8,
    enabled: bool,
    port: u16,
    server_id: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessDeviceFile {
    version: u8,
    devices: Vec<AccessDeviceRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessDeviceRecord {
    device_id: String,
    name: String,
    scope: AccessScope,
    public_key: String,
    created_at_epoch_ms: u64,
    last_seen_at_epoch_ms: Option<u64>,
    revoked_at_epoch_ms: Option<u64>,
}

struct PairingInvitation {
    name: String,
    scope: AccessScope,
    expires_at_epoch_ms: u64,
}

pub(in crate::app) struct RemoteRevocation {
    device_id: String,
    receiver: broadcast::Receiver<String>,
}

impl RemoteRevocation {
    pub(in crate::app) async fn wait(&mut self) {
        loop {
            match self.receiver.recv().await {
                Ok(device_id) if device_id == self.device_id || device_id == "*" => return,
                Ok(_) => continue,
                // Revocation is a security boundary. Once this receiver misses
                // any event it can no longer prove that its own device stayed
                // authorized, so close the connection rather than guessing.
                Err(broadcast::error::RecvError::Lagged(_)) => return,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

pub(in crate::app) struct AuthenticatedDevice {
    pub(in crate::app) scope: RemoteScope,
    connection_token: String,
    pub(in crate::app) revocation: RemoteRevocation,
}

impl AccessPlane {
    pub(in crate::app) fn open(state_directory: &Path) -> Result<Self, String> {
        let config_path = state_directory.join(ACCESS_CONFIG_FILE);
        let devices_path = state_directory.join(ACCESS_DEVICE_FILE);
        let mut startup_error = None;
        let mut config = match termloop_platform::read_bounded_file_if_present(
            &config_path,
            ACCESS_FILE_LIMIT,
        ) {
            Ok(Some(bytes)) => match serde_json::from_slice::<AccessConfig>(&bytes)
                .map_err(|_| "access configuration is invalid".to_owned())
                .and_then(|config| validate_config(&config).map(|()| config))
            {
                Ok(config) => config,
                Err(error) => {
                    startup_error = Some(error);
                    default_access_config()
                }
            },
            Ok(None) => {
                let config = default_access_config();
                if let Err(error) = termloop_platform::write_private_file(
                    &config_path,
                    &serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
                ) {
                    startup_error = Some(format!(
                        "access configuration could not be created: {error}"
                    ));
                }
                config
            }
            Err(error) => {
                startup_error = Some(format!("access configuration could not be read: {error}"));
                default_access_config()
            }
        };
        let devices =
            match termloop_platform::read_bounded_file_if_present(&devices_path, ACCESS_FILE_LIMIT)
            {
                Ok(Some(bytes)) => match serde_json::from_slice::<AccessDeviceFile>(&bytes)
                    .map_err(|_| "access device registry is invalid".to_owned())
                    .and_then(|devices| validate_devices(&devices).map(|()| devices))
                {
                    Ok(devices) => devices,
                    Err(error) => {
                        config.enabled = false;
                        startup_error = Some(error);
                        empty_device_file()
                    }
                },
                Ok(None) => empty_device_file(),
                Err(error) => {
                    config.enabled = false;
                    startup_error =
                        Some(format!("access device registry could not be read: {error}"));
                    empty_device_file()
                }
            };
        let (revocations, _) = broadcast::channel(128);
        Ok(Self {
            inner: Arc::new(AccessPlaneInner {
                config_path,
                devices_path,
                config: StdMutex::new(config),
                devices: StdMutex::new(devices),
                invitations: StdMutex::new(HashMap::new()),
                device_registration_attempts: StdMutex::new(VecDeque::new()),
                revocations,
                management: tokio::sync::Mutex::new(()),
                lifecycle: tokio::sync::Mutex::new(None),
                listening: AtomicBool::new(false),
                last_error: StdMutex::new(startup_error),
            }),
        })
    }

    pub(in crate::app) async fn start_if_enabled(&self, state: AppState) {
        let _management = self.inner.management.lock().await;
        let config = self
            .inner
            .config
            .lock()
            .expect("access config poisoned")
            .clone();
        if !config.enabled {
            return;
        }
        if let Err(error) = self.start_listener(state, config.port).await {
            self.set_error(Some(error));
        }
    }

    pub(in crate::app) async fn enable(
        &self,
        state: AppState,
        requested_port: Option<u16>,
    ) -> Result<AccessStatusDto, String> {
        let _management = self.inner.management.lock().await;
        let current = self
            .inner
            .config
            .lock()
            .expect("access config poisoned")
            .clone();
        let port = requested_port.unwrap_or(current.port);
        if port < 1024 {
            return Err("access port must be between 1024 and 65535".to_owned());
        }
        self.start_listener(state.clone(), port).await?;
        let mut next = current.clone();
        next.enabled = true;
        next.port = port;
        if let Err(error) = self.persist_config(&next) {
            self.stop_listener().await;
            let error = if current.enabled {
                match self.start_listener(state, current.port).await {
                    Ok(()) => error,
                    Err(restore) => format!(
                        "{error}; previous access listener could not be restored: {restore}"
                    ),
                }
            } else {
                error
            };
            self.set_error(Some(error.clone()));
            return Err(error);
        }
        *self.inner.config.lock().expect("access config poisoned") = next;
        self.set_error(None);
        Ok(self.status())
    }

    pub(in crate::app) async fn disable(&self) -> Result<AccessStatusDto, String> {
        let _management = self.inner.management.lock().await;
        {
            let mut config = self.inner.config.lock().expect("access config poisoned");
            let mut next = config.clone();
            next.enabled = false;
            self.persist_config(&next)?;
            *config = next;
            self.inner
                .invitations
                .lock()
                .expect("access invitations poisoned")
                .clear();
        }
        let _ = self.inner.revocations.send("*".to_owned());
        self.stop_listener().await;
        self.set_error(None);
        Ok(self.status())
    }

    pub(in crate::app) async fn shutdown(&self) {
        let _management = self.inner.management.lock().await;
        let _ = self.inner.revocations.send("*".to_owned());
        self.stop_listener().await;
    }

    pub(in crate::app) fn status(&self) -> AccessStatusDto {
        let config = self
            .inner
            .config
            .lock()
            .expect("access config poisoned")
            .clone();
        let listening = self.inner.listening.load(Ordering::Acquire);
        AccessStatusDto {
            enabled: config.enabled,
            listening,
            port: config.enabled.then_some(config.port),
            access_url: listening.then(|| format!("ws://127.0.0.1:{}", config.port)),
            server_fingerprint: termloop_platform::access_server_fingerprint(&config.server_id),
            error: self
                .inner
                .last_error
                .lock()
                .expect("access error state poisoned")
                .clone(),
        }
    }

    pub(in crate::app) async fn create_pairing(
        &self,
        name: String,
        scope: AccessScope,
    ) -> Result<AccessPairingInvitationDto, String> {
        let _management = self.inner.management.lock().await;
        let status = self.status();
        let Some(access_url) = status.enabled.then_some(status.access_url).flatten() else {
            return Err("access plane is not listening".to_owned());
        };
        let now = termloop_platform::current_epoch_ms();
        let pairing_code = termloop_platform::generate_pairing_code();
        let expires_at_epoch_ms = now.saturating_add(PAIRING_TTL_MS);
        let mut invitations = self
            .inner
            .invitations
            .lock()
            .expect("access invitations poisoned");
        invitations.retain(|_, invitation| invitation.expires_at_epoch_ms >= now);
        if invitations.len() >= MAX_ACTIVE_PAIRING_INVITATIONS {
            return Err("too many pairing invitations are active".to_owned());
        }
        invitations.insert(
            termloop_platform::pairing_code_digest(&pairing_code),
            PairingInvitation {
                name,
                scope: scope.clone(),
                expires_at_epoch_ms,
            },
        );
        Ok(AccessPairingInvitationDto {
            pairing_code,
            expires_at_epoch_ms,
            access_url,
            server_fingerprint: status.server_fingerprint,
            scope,
        })
    }

    pub(in crate::app) fn devices(&self) -> Vec<AccessDeviceDto> {
        self.inner
            .devices
            .lock()
            .expect("access device registry poisoned")
            .devices
            .iter()
            .map(device_dto)
            .collect()
    }

    pub(in crate::app) fn revoke(&self, device_id: &str) -> Result<bool, String> {
        let mut devices = self
            .inner
            .devices
            .lock()
            .expect("access device registry poisoned");
        let mut next = devices.clone();
        let Some(index) = next
            .devices
            .iter()
            .position(|device| device.device_id == device_id)
        else {
            return Ok(false);
        };
        if next.devices[index].revoked_at_epoch_ms.is_some() {
            return Ok(false);
        }
        next.devices[index].revoked_at_epoch_ms = Some(termloop_platform::current_epoch_ms());
        self.persist_devices(&next)?;
        *devices = next;
        let _ = self.inner.revocations.send(device_id.to_owned());
        Ok(true)
    }

    fn start_listener(
        &self,
        state: AppState,
        port: u16,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let mut lifecycle = self.inner.lifecycle.lock().await;
            if lifecycle
                .as_ref()
                .is_some_and(|listener| listener.port == port && !listener.task.is_finished())
            {
                self.inner.listening.store(true, Ordering::Release);
                return Ok(());
            }
            let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
            let listener = TcpListener::bind(address)
                .await
                .map_err(|error| format!("access listener could not bind: {error}"))?;
            if lifecycle
                .as_ref()
                .is_some_and(|existing| existing.port != port)
            {
                // Close old-port connections before waiting for that listener
                // to drain. Receivers created by the replacement listener do
                // not observe this already-sent broadcast.
                let _ = self.inner.revocations.send("*".to_owned());
            }
            if let Some(listener) = lifecycle.take() {
                stop_listener(listener).await;
            }
            let app = Router::new()
                .route("/control", get(access_control_upgrade))
                .route("/terminal", get(access_terminal_upgrade))
                .route("/enroll", get(access_enroll_upgrade))
                .route("/pair", get(access_pair_upgrade))
                .route(
                    "/forward",
                    get(super::forward_plane::access_forward_upgrade),
                )
                .route("/attachments", post(super::attachments::attachment_upload))
                .with_state(state);
            let (shutdown, mut shutdown_receiver) = watch::channel(false);
            let inner = self.inner.clone();
            let task = tokio::spawn(async move {
                let mut next_listener = Some(listener);
                loop {
                    let listener = match next_listener.take() {
                        Some(listener) => listener,
                        None => match TcpListener::bind(address).await {
                            Ok(listener) => listener,
                            Err(error) => {
                                *inner
                                    .last_error
                                    .lock()
                                    .expect("access error state poisoned") =
                                    Some(format!("access listener recovery bind failed: {error}"));
                                tokio::select! {
                                    _ = shutdown_receiver.changed() => break,
                                    () = tokio::time::sleep(Duration::from_secs(2)) => continue,
                                }
                            }
                        },
                    };
                    inner.listening.store(true, Ordering::Release);
                    *inner
                        .last_error
                        .lock()
                        .expect("access error state poisoned") = None;
                    let mut serve_shutdown = shutdown_receiver.clone();
                    let serving =
                        axum::serve(listener, app.clone()).with_graceful_shutdown(async move {
                            while !*serve_shutdown.borrow() {
                                if serve_shutdown.changed().await.is_err() {
                                    break;
                                }
                            }
                        });
                    let result = std::panic::AssertUnwindSafe(serving.into_future())
                        .catch_unwind()
                        .await;
                    inner.listening.store(false, Ordering::Release);
                    if *shutdown_receiver.borrow() {
                        break;
                    }
                    let message = match result {
                        Ok(Ok(())) => "access listener stopped unexpectedly".to_owned(),
                        Ok(Err(error)) => format!("access listener stopped: {error}"),
                        Err(_) => "access listener panicked".to_owned(),
                    };
                    *inner
                        .last_error
                        .lock()
                        .expect("access error state poisoned") = Some(message);
                    tokio::select! {
                        _ = shutdown_receiver.changed() => break,
                        () = tokio::time::sleep(Duration::from_millis(500)) => {}
                    }
                }
            });
            *lifecycle = Some(AccessListener {
                port,
                shutdown,
                task,
            });
            self.inner.listening.store(true, Ordering::Release);
            Ok(())
        })
    }

    async fn stop_listener(&self) {
        let listener = self.inner.lifecycle.lock().await.take();
        if let Some(listener) = listener {
            stop_listener(listener).await;
        }
        self.inner.listening.store(false, Ordering::Release);
    }

    fn persist_config(&self, config: &AccessConfig) -> Result<(), String> {
        termloop_platform::atomic_replace_private_file(
            &self.inner.config_path,
            &serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }

    fn persist_devices(&self, devices: &AccessDeviceFile) -> Result<(), String> {
        let encoded = serde_json::to_vec_pretty(devices).map_err(|error| error.to_string())?;
        if encoded.len() > ACCESS_FILE_LIMIT {
            return Err("access device registry exceeds its durable size limit".to_owned());
        }
        termloop_platform::atomic_replace_private_file(&self.inner.devices_path, &encoded)
            .map_err(|error| error.to_string())
    }

    fn set_error(&self, error: Option<String>) {
        *self
            .inner
            .last_error
            .lock()
            .expect("access error state poisoned") = error;
    }

    fn device_registration_attempt_allowed(&self) -> bool {
        let now = termloop_platform::current_epoch_ms();
        let mut attempts = self
            .inner
            .device_registration_attempts
            .lock()
            .expect("access device registration rate limit poisoned");
        while attempts
            .front()
            .is_some_and(|timestamp| now.saturating_sub(*timestamp) >= 60_000)
        {
            attempts.pop_front();
        }
        if attempts.len() >= MAX_DEVICE_REGISTRATION_ATTEMPTS_PER_MINUTE {
            return false;
        }
        attempts.push_back(now);
        true
    }

    fn exchange_pairing(
        &self,
        pairing_code: &str,
        public_key: &str,
    ) -> Result<AccessDeviceRecord, String> {
        // Keep the enabled check and invitation consumption in the same lock
        // order used by `disable`. The exchange therefore linearizes wholly
        // before disable, or observes the disabled state after it; it cannot
        // recreate an invitation/device in the gap after invitations clear.
        let config_guard = self.inner.config.lock().expect("access config poisoned");
        if !config_guard.enabled {
            return Err("access plane is disabled".to_owned());
        }
        if !self.device_registration_attempt_allowed() {
            return Err("pairing attempt limit exceeded".to_owned());
        }
        if !termloop_platform::access_public_key_valid(public_key) {
            return Err("device public key is invalid".to_owned());
        }
        let now = termloop_platform::current_epoch_ms();
        let digest = termloop_platform::pairing_code_digest(pairing_code);
        let invitation = self
            .inner
            .invitations
            .lock()
            .expect("access invitations poisoned")
            .remove(&digest)
            .filter(|invitation| invitation.expires_at_epoch_ms >= now)
            .ok_or_else(|| "pairing invitation is invalid or expired".to_owned())?;
        let device = AccessDeviceRecord {
            device_id: termloop_platform::generate_opaque_id(),
            name: invitation.name,
            scope: invitation.scope,
            public_key: public_key.to_owned(),
            created_at_epoch_ms: now,
            last_seen_at_epoch_ms: None,
            revoked_at_epoch_ms: None,
        };
        let mut devices = self
            .inner
            .devices
            .lock()
            .expect("access device registry poisoned");
        if devices.devices.len() >= MAX_PAIRED_DEVICES {
            return Err("paired device limit exceeded".to_owned());
        }
        let mut next = devices.clone();
        next.devices.push(device.clone());
        self.persist_devices(&next)?;
        *devices = next;
        drop(config_guard);
        Ok(device)
    }

    fn enroll_device(
        &self,
        device_name: &str,
        public_key: &str,
    ) -> Result<AccessDeviceRecord, String> {
        // Enrollment authority is the explicit access-plane enable switch plus
        // transport reachability. Tailscale ACLs or SSH authentication decide
        // which remote machines can reach this loopback-only listener.
        let config_guard = self.inner.config.lock().expect("access config poisoned");
        if !config_guard.enabled {
            return Err("access plane is disabled".to_owned());
        }
        if !self.device_registration_attempt_allowed() {
            return Err("device enrollment attempt limit exceeded".to_owned());
        }
        let device_name = device_name.trim();
        if device_name.is_empty() || device_name.chars().count() > 80 {
            return Err("device name is invalid".to_owned());
        }
        if !termloop_platform::access_public_key_valid(public_key) {
            return Err("device public key is invalid".to_owned());
        }
        let mut devices = self
            .inner
            .devices
            .lock()
            .expect("access device registry poisoned");
        if let Some(existing) = devices
            .devices
            .iter()
            .find(|device| device.public_key == public_key)
        {
            return if existing.revoked_at_epoch_ms.is_some() {
                Err("device credential is revoked".to_owned())
            } else {
                Ok(existing.clone())
            };
        }
        if devices.devices.len() >= MAX_PAIRED_DEVICES {
            return Err("paired device limit exceeded".to_owned());
        }
        let device = AccessDeviceRecord {
            device_id: termloop_platform::generate_opaque_id(),
            name: device_name.to_owned(),
            scope: AccessScope::Full,
            public_key: public_key.to_owned(),
            created_at_epoch_ms: termloop_platform::current_epoch_ms(),
            last_seen_at_epoch_ms: None,
            revoked_at_epoch_ms: None,
        };
        let mut next = devices.clone();
        next.devices.push(device.clone());
        self.persist_devices(&next)?;
        *devices = next;
        drop(config_guard);
        Ok(device)
    }

    fn authenticate(
        &self,
        device_id: &str,
        server_fingerprint: &str,
        channel: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<(RemoteScope, String), String> {
        let mut devices = self
            .inner
            .devices
            .lock()
            .expect("access device registry poisoned");
        let mut next = devices.clone();
        let device = next
            .devices
            .iter_mut()
            .find(|device| device.device_id == device_id && device.revoked_at_epoch_ms.is_none())
            .ok_or_else(|| "device is unknown or revoked".to_owned())?;
        if !termloop_platform::verify_access_signature(
            &device.public_key,
            server_fingerprint,
            channel,
            nonce,
            signature,
        ) {
            return Err("device proof is invalid".to_owned());
        }
        let now = termloop_platform::current_epoch_ms();
        let scope = RemoteScope::from(&device.scope);
        if device
            .last_seen_at_epoch_ms
            .is_none_or(|last_seen| now.saturating_sub(last_seen) >= LAST_SEEN_PERSIST_INTERVAL_MS)
        {
            device.last_seen_at_epoch_ms = Some(now);
            self.persist_devices(&next)?;
            *devices = next;
        }
        Ok((scope, termloop_platform::generate_capability_token()))
    }

    pub(in crate::app) async fn authenticate_socket(
        &self,
        socket: &mut WebSocket,
        channel: AccessChannel,
    ) -> Result<AuthenticatedDevice, String> {
        // Subscribe before checking the registry so a revoke racing with a
        // successful proof cannot fall between authorization and subscription.
        let revocation_receiver = self.inner.revocations.subscribe();
        // The wildcard disable broadcast may have happened immediately before
        // this socket subscribed. Checking the durable lifecycle flag after
        // subscription closes both sides of that race: either this check sees
        // disabled, or the receiver observes the later broadcast.
        if !self
            .inner
            .config
            .lock()
            .expect("access config poisoned")
            .enabled
        {
            return Err("access plane is disabled".to_owned());
        }
        let channel_name = match channel {
            AccessChannel::Control => "control",
            AccessChannel::Terminal => "terminal",
            AccessChannel::Forward => "forward",
        };
        let nonce = termloop_platform::generate_access_nonce();
        let server_fingerprint = self.status().server_fingerprint;
        let challenge = AccessChallenge {
            kind: "challenge".to_owned(),
            protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
            control_protocol_version: CONTRACT_IDENTITY.to_owned(),
            channel,
            nonce: nonce.clone(),
            server_fingerprint: server_fingerprint.clone(),
        };
        send_json(socket, &challenge).await?;
        let text = timeout(HANDSHAKE_TIMEOUT, socket.recv())
            .await
            .map_err(|_| "access authentication timed out".to_owned())?
            .ok_or_else(|| "access authentication ended".to_owned())?
            .map_err(|_| "access authentication transport failed".to_owned())?;
        let Message::Text(text) = text else {
            return Err("access authentication must be JSON text".to_owned());
        };
        if text.len() > MAX_HANDSHAKE_MESSAGE {
            return Err("access authentication message is too large".to_owned());
        }
        let request = serde_json::from_str::<AccessAuthenticate>(&text)
            .map_err(|_| "access authentication message is invalid".to_owned())?;
        if request.kind != "authenticate" || request.protocol_version != ACCESS_PROTOCOL_IDENTITY {
            return Err("access protocol version is unsupported".to_owned());
        }
        let (scope, connection_token) = self.authenticate(
            &request.device_id,
            &server_fingerprint,
            channel_name,
            &nonce,
            &request.signature,
        )?;
        send_json(
            socket,
            &AccessAuthenticated {
                kind: "authenticated".to_owned(),
                protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
                device_id: request.device_id.clone(),
                scope: scope.protocol(),
                connection_token: connection_token.clone(),
            },
        )
        .await?;
        Ok(AuthenticatedDevice {
            scope,
            connection_token,
            revocation: RemoteRevocation {
                device_id: request.device_id,
                receiver: revocation_receiver,
            },
        })
    }
}

async fn stop_listener(listener: AccessListener) {
    let _ = listener.shutdown.send(true);
    let mut task = listener.task;
    if timeout(Duration::from_secs(2), &mut task).await.is_err() {
        task.abort();
    }
}

async fn access_control_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Match the local listener: admit a modestly oversized frame so control
    // can return the generated typed error instead of an opaque socket close.
    ws.max_message_size(super::control::MAX_CONTROL_MESSAGE * 2)
        .on_upgrade(move |socket| access_control_socket(socket, state))
}

async fn access_control_socket(mut socket: WebSocket, state: AppState) {
    let authenticated = match state
        .access_plane
        .authenticate_socket(&mut socket, AccessChannel::Control)
        .await
    {
        Ok(authenticated) => authenticated,
        Err(message) => {
            let _ = send_protocol_error(&mut socket, "unauthenticated", &message).await;
            return;
        }
    };
    let credential = RemoteControlCredential {
        token: Arc::from(authenticated.connection_token),
        scope: match authenticated.scope {
            RemoteScope::Full => ClientScope::Full,
            RemoteScope::ReadOnly => ClientScope::ReadOnly,
        },
    };
    control_socket(
        socket,
        state,
        ConnectionOrigin::RemoteDevice,
        Some(credential),
        Some(authenticated.revocation),
    )
    .await;
}

async fn access_terminal_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| access_terminal_socket(socket, state))
}

async fn access_terminal_socket(mut socket: WebSocket, state: AppState) {
    let authenticated = match state
        .access_plane
        .authenticate_socket(&mut socket, AccessChannel::Terminal)
        .await
    {
        Ok(authenticated) => authenticated,
        Err(message) => {
            let _ = send_protocol_error(&mut socket, "unauthenticated", &message).await;
            return;
        }
    };
    terminal_socket_remote(
        socket,
        state,
        authenticated.connection_token,
        authenticated.scope.allows_terminal_input(),
        authenticated.revocation,
    )
    .await;
}

async fn access_enroll_upgrade(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    // Browser WebSockets always carry Origin and cannot add a native-client
    // secret header. Rejecting them prevents an arbitrary web page opened on a
    // tailnet device from enrolling itself while sharing is enabled. Native
    // desktop/CLI clients and SSH tunnels do not send Origin.
    if !enrollment_origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_HANDSHAKE_MESSAGE)
        .on_upgrade(move |socket| access_enroll_socket(socket, state.access_plane))
        .into_response()
}

fn enrollment_origin_allowed(headers: &HeaderMap) -> bool {
    !headers.contains_key(header::ORIGIN)
}

async fn access_enroll_socket(mut socket: WebSocket, access_plane: AccessPlane) {
    let server_fingerprint = access_plane.status().server_fingerprint;
    if send_json(
        &mut socket,
        &AccessPairChallenge {
            kind: "pairChallenge".to_owned(),
            protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
            server_fingerprint: server_fingerprint.clone(),
        },
    )
    .await
    .is_err()
    {
        return;
    }
    let request = timeout(HANDSHAKE_TIMEOUT, socket.recv()).await;
    let request = match request {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= MAX_HANDSHAKE_MESSAGE => {
            serde_json::from_str::<AccessEnroll>(&text).ok()
        }
        _ => None,
    };
    let Some(request) = request else {
        let _ = send_protocol_error(
            &mut socket,
            "invalidMessage",
            "device enrollment message is invalid",
        )
        .await;
        return;
    };
    if request.kind != "enroll" || request.protocol_version != ACCESS_PROTOCOL_IDENTITY {
        let _ = send_protocol_error(
            &mut socket,
            "unsupportedVersion",
            "access protocol version is unsupported",
        )
        .await;
        return;
    }
    if request.server_fingerprint != server_fingerprint {
        let _ = send_protocol_error(
            &mut socket,
            "enrollmentDenied",
            "server fingerprint changed during enrollment",
        )
        .await;
        return;
    }
    match access_plane.enroll_device(&request.device_name, &request.public_key) {
        Ok(device) => {
            let _ = send_json(
                &mut socket,
                &AccessEnrolled {
                    kind: "enrolled".to_owned(),
                    protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
                    device_id: device.device_id,
                    scope: RemoteScope::from(&device.scope).protocol(),
                    server_fingerprint,
                },
            )
            .await;
        }
        Err(message) => {
            let _ = send_protocol_error(&mut socket, "enrollmentDenied", &message).await;
        }
    }
}

async fn access_pair_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(MAX_HANDSHAKE_MESSAGE)
        .on_upgrade(move |socket| access_pair_socket(socket, state.access_plane))
}

async fn access_pair_socket(mut socket: WebSocket, access_plane: AccessPlane) {
    let server_fingerprint = access_plane.status().server_fingerprint;
    if send_json(
        &mut socket,
        &AccessPairChallenge {
            kind: "pairChallenge".to_owned(),
            protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
            server_fingerprint: server_fingerprint.clone(),
        },
    )
    .await
    .is_err()
    {
        return;
    }
    let request = timeout(HANDSHAKE_TIMEOUT, socket.recv()).await;
    let request = match request {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= MAX_HANDSHAKE_MESSAGE => {
            serde_json::from_str::<AccessPairExchange>(&text).ok()
        }
        _ => None,
    };
    let Some(request) = request else {
        let _ =
            send_protocol_error(&mut socket, "invalidMessage", "pairing message is invalid").await;
        return;
    };
    if request.kind != "pairExchange" || request.protocol_version != ACCESS_PROTOCOL_IDENTITY {
        let _ = send_protocol_error(
            &mut socket,
            "unsupportedVersion",
            "access protocol version is unsupported",
        )
        .await;
        return;
    }
    if request.server_fingerprint != server_fingerprint {
        let _ = send_protocol_error(
            &mut socket,
            "pairingDenied",
            "server fingerprint does not match the pairing invitation",
        )
        .await;
        return;
    }
    match access_plane.exchange_pairing(&request.pairing_code, &request.public_key) {
        Ok(device) => {
            let _ = send_json(
                &mut socket,
                &AccessPaired {
                    kind: "paired".to_owned(),
                    protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
                    device_id: device.device_id,
                    scope: RemoteScope::from(&device.scope).protocol(),
                    server_fingerprint,
                },
            )
            .await;
        }
        Err(message) => {
            let _ = send_protocol_error(&mut socket, "pairingDenied", &message).await;
        }
    }
}

async fn send_json<T: Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), String> {
    socket
        .send(Message::Text(
            serde_json::to_string(value)
                .map_err(|error| error.to_string())?
                .into(),
        ))
        .await
        .map_err(|_| "access transport send failed".to_owned())
}

pub(in crate::app) async fn send_protocol_error(
    socket: &mut WebSocket,
    code: &str,
    message: &str,
) -> Result<(), String> {
    send_json(
        socket,
        &AccessProtocolError {
            kind: "error".to_owned(),
            protocol_version: ACCESS_PROTOCOL_IDENTITY.to_owned(),
            code: code.to_owned(),
            message: message.chars().take(200).collect(),
        },
    )
    .await
}

fn device_dto(device: &AccessDeviceRecord) -> AccessDeviceDto {
    AccessDeviceDto {
        device_id: device.device_id.clone(),
        name: device.name.clone(),
        scope: device.scope.clone(),
        created_at_epoch_ms: device.created_at_epoch_ms,
        last_seen_at_epoch_ms: device.last_seen_at_epoch_ms,
        revoked_at_epoch_ms: device.revoked_at_epoch_ms,
    }
}

fn default_access_config() -> AccessConfig {
    AccessConfig {
        version: 1,
        enabled: false,
        port: DEFAULT_ACCESS_PORT,
        server_id: termloop_platform::generate_opaque_id(),
    }
}

fn empty_device_file() -> AccessDeviceFile {
    AccessDeviceFile {
        version: 1,
        devices: Vec::new(),
    }
}

fn validate_config(config: &AccessConfig) -> Result<(), String> {
    if config.version != 1
        || config.port < 1024
        || !matches!(config.server_id.len(), 32 | 64)
        || !config
            .server_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("access configuration is unsupported".to_owned());
    }
    Ok(())
}

fn validate_devices(devices: &AccessDeviceFile) -> Result<(), String> {
    if devices.version != 1 || devices.devices.len() > MAX_PAIRED_DEVICES {
        return Err("access device registry is unsupported".to_owned());
    }
    let mut device_ids = HashSet::with_capacity(devices.devices.len());
    for device in &devices.devices {
        if device.device_id.len() != 32
            || !device
                .device_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || device.name.is_empty()
            || device.name.chars().count() > 80
            || !termloop_platform::access_public_key_valid(&device.public_key)
            || !device_ids.insert(&device.device_id)
        {
            return Err("access device registry contains an invalid device".to_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_access_plane_is_disabled_and_has_stable_fingerprint() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-plane-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        let first = plane.status();
        let reopened = AccessPlane::open(&root).unwrap().status();
        assert!(!first.enabled);
        assert!(!first.listening);
        assert_eq!(first.server_fingerprint, reopened.server_fingerprint);
        assert_eq!(first.port, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn maximum_valid_device_registry_fits_the_durable_read_limit() {
        let devices = AccessDeviceFile {
            version: 1,
            devices: (0..MAX_PAIRED_DEVICES)
                .map(|index| AccessDeviceRecord {
                    device_id: format!("{index:032x}"),
                    name: "😀".repeat(80),
                    scope: AccessScope::ReadOnly,
                    public_key: "1CU--IOUP6utG3zi03UcWZ4a-FVfo2SOyW4KBaZRQcU".to_owned(),
                    created_at_epoch_ms: u64::MAX,
                    last_seen_at_epoch_ms: Some(u64::MAX),
                    revoked_at_epoch_ms: Some(u64::MAX),
                })
                .collect(),
        };
        assert!(validate_devices(&devices).is_ok());
        assert!(serde_json::to_vec_pretty(&devices).unwrap().len() <= ACCESS_FILE_LIMIT);
    }

    #[tokio::test]
    async fn invitation_is_runtime_only_and_expiry_is_enforced() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-pairing-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        plane.inner.listening.store(true, Ordering::Release);
        {
            let mut config = plane.inner.config.lock().unwrap();
            config.enabled = true;
        }
        let invitation = plane
            .create_pairing("Laptop".to_owned(), AccessScope::Full)
            .await
            .unwrap();
        assert!(
            !std::fs::read_to_string(root.join(ACCESS_CONFIG_FILE))
                .unwrap()
                .contains(&invitation.pairing_code)
        );
        plane
            .inner
            .invitations
            .lock()
            .unwrap()
            .get_mut(&termloop_platform::pairing_code_digest(
                &invitation.pairing_code,
            ))
            .unwrap()
            .expires_at_epoch_ms = 0;
        assert!(
            plane
                .exchange_pairing(
                    &invitation.pairing_code,
                    "1CU--IOUP6utG3zi03UcWZ4a-FVfo2SOyW4KBaZRQcU",
                )
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn enabled_access_enrolls_full_scope_devices_without_a_code() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-enrollment-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        let public_key = "1CU--IOUP6utG3zi03UcWZ4a-FVfo2SOyW4KBaZRQcU";

        assert!(plane.enroll_device("Laptop", public_key).is_err());
        plane.inner.config.lock().unwrap().enabled = true;

        let enrolled = plane.enroll_device("Laptop", public_key).unwrap();
        let retried = plane.enroll_device("Renamed laptop", public_key).unwrap();
        assert_eq!(enrolled.device_id, retried.device_id);
        assert_eq!(enrolled.scope, AccessScope::Full);
        assert_eq!(plane.devices().len(), 1);

        assert!(plane.revoke(&enrolled.device_id).unwrap());
        assert!(plane.enroll_device("Laptop", public_key).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn browser_origin_cannot_reach_code_free_enrollment() {
        let mut headers = HeaderMap::new();
        assert!(enrollment_origin_allowed(&headers));
        headers.insert(header::ORIGIN, "https://example.com".parse().unwrap());
        assert!(!enrollment_origin_allowed(&headers));
    }

    #[tokio::test]
    async fn pairing_invitations_are_bounded_and_expired_entries_free_capacity() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-pairing-limit-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        plane.inner.listening.store(true, Ordering::Release);
        plane.inner.config.lock().unwrap().enabled = true;
        for index in 0..MAX_ACTIVE_PAIRING_INVITATIONS {
            plane.inner.invitations.lock().unwrap().insert(
                termloop_platform::pairing_code_digest(&format!("fixture-{index}")),
                PairingInvitation {
                    name: "Laptop".to_owned(),
                    scope: AccessScope::Full,
                    expires_at_epoch_ms: u64::MAX,
                },
            );
        }
        assert!(
            plane
                .create_pairing("Another".to_owned(), AccessScope::Full)
                .await
                .is_err()
        );
        plane
            .inner
            .invitations
            .lock()
            .unwrap()
            .values_mut()
            .next()
            .unwrap()
            .expires_at_epoch_ms = 0;
        assert!(
            plane
                .create_pairing("Another".to_owned(), AccessScope::Full)
                .await
                .is_ok()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_access_files_fail_closed_without_preventing_local_startup() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-corrupt-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        let config_path = root.join(ACCESS_CONFIG_FILE);
        let devices_path = root.join(ACCESS_DEVICE_FILE);
        let mut config = plane.inner.config.lock().unwrap().clone();
        config.enabled = true;
        termloop_platform::atomic_replace_private_file(
            &config_path,
            &serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        termloop_platform::write_private_file(&devices_path, b"not-json").unwrap();

        let recovered = AccessPlane::open(&root).unwrap();
        let status = recovered.status();
        assert!(!status.enabled);
        assert!(!status.listening);
        assert_eq!(
            status.error.as_deref(),
            Some("access device registry is invalid")
        );
        assert!(recovered.devices().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn missed_revocation_events_fail_closed() {
        let (sender, receiver) = broadcast::channel(1);
        let mut revocation = RemoteRevocation {
            device_id: "target".to_owned(),
            receiver,
        };
        sender.send("other-a".to_owned()).unwrap();
        sender.send("other-b".to_owned()).unwrap();

        timeout(Duration::from_millis(50), revocation.wait())
            .await
            .expect("a lagged revocation receiver must close the connection");
    }

    #[tokio::test]
    async fn disabling_access_invalidates_outstanding_pairing_invitations() {
        let root = std::env::temp_dir().join(format!(
            "termloop-access-disable-pairing-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        let plane = AccessPlane::open(&root).unwrap();
        plane.inner.listening.store(true, Ordering::Release);
        plane.inner.config.lock().unwrap().enabled = true;
        let invitation = plane
            .create_pairing("Laptop".to_owned(), AccessScope::Full)
            .await
            .unwrap();

        plane.disable().await.unwrap();

        assert!(
            plane
                .exchange_pairing(
                    &invitation.pairing_code,
                    "1CU--IOUP6utG3zi03UcWZ4a-FVfo2SOyW4KBaZRQcU",
                )
                .is_err()
        );
        assert!(
            plane
                .create_pairing("Another".to_owned(), AccessScope::Full)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
