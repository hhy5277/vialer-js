/**
* The Background app namespace.
* @namespace AppBackground
*/
const Api = require('./lib/api')
const App = require('../lib/app')
const Crypto = require('./lib/crypto')
const Devices = require('./lib/devices')
const env = require('../lib/env')({role: 'bg'})
const Store = require('./lib/store')
const Telemetry = require('./lib/telemetry')
const Timer = require('./lib/timer')


/**
* The Vialer-js `AppBackground` is a separate running script.
* Functionality that is considered to be part of the backend
* is placed in this context because this process keeps running
* after the AppForeground (the popup) is closed (at least, when running
* the application as WebExtension). In that sense, this is a typical
* client-server model. When running as a webview, the background is just
* as volatile as the foreground, but the same concept can be used nevertheless.
* @memberof app
*/
class AppBackground extends App {
    /**
    * @param {Object} opts - Options to initialize AppBackground with.
    * @param {Object} opts.env - The environment sniffer.
    * @namespace AppBackground.modules
    */
    constructor(opts) {
        super(opts)

        // Allow context debugging during development.
        // Avoid leaking this global in production mode!
        if (!(process.env.NODE_ENV === 'production')) global.bg = this

        this.store = new Store(this)
        this.crypto = new Crypto(this)
        this.timer = new Timer(this)

        this.__mergeQueue = {}
        this.__mergeIndex = 0

        this._watchers = []

        // Send the background script's state to the requesting event.
        this.on('bg:get_state', ({callback}) => {
            callback(JSON.stringify(this.state))
        })
        this.on('bg:refresh_api_data', this._platformData.bind(this))
        // Calls to setState from the foreground.
        this.on('bg:set_state', (...args) => {
            this.__mergeStateQueue(...args)
        })

        this.__init()
    }


    /**
    * Send a notification to the user that all its data is removed
    * from the plugin and why. This is used as a quick-and-dirty replacement
    * for migrations when state structure changes between versions. It requires
    * the user to login again.
    * @param {Object} opts - Factory default options.
    * @param {String} opts.title - Notification title.
    * @param {String} opts.message - Notification body.
    */
    __factoryDefaults({title, message}) {
        if (title && message) {
            this.modules.ui.notification({force: true, message, title})
        }

        this.store.clear()
        this.emit('factory-defaults')
        if (this.env.isBrowser) location.reload()
    }


    async __init() {
        if (this.env.isBrowser) {
            // Create audio/video elements in a browser-like environment.
            // The audio element is used to playback sounds with
            // (like ringtones, dtmftones). The video element is
            // used to attach the remote WebRTC stream to.
            this.localVideo = document.createElement('video')
            this.localVideo.setAttribute('id', 'local')
            this.localVideo.muted = true

            this.remoteVideo = document.createElement('video')
            this.remoteVideo.setAttribute('id', 'remote')
            document.body.prepend(this.localVideo)
            document.body.prepend(this.remoteVideo)

            // Trigger play automatically. This is required for any audio
            // to play during a call.
            this.remoteVideo.addEventListener('canplay', () => this.remoteVideo.play())
            this.localVideo.addEventListener('canplay', () => this.localVideo.play())
        }

        // Start by initializing builtin modules.
        for (const builtin of this._modules.builtin) {
            if (builtin.adapter || builtin.providers) {
                if (builtin.providers) {
                    const providers = builtin.providers.map((mod) => require(mod))
                    this.modules[builtin.name] = new builtin.module(this, providers)
                } else if (builtin.adapter) {
                    this.modules[builtin.name] = new builtin.module(this, require(builtin.adapter))
                }
            } else {
                this.modules[builtin.name] = new builtin.module(this, null)
            }
        }

        // Then process custom modules.
        for (const custom of this._modules.custom) {
            const Module = require(custom.module)
            this.modules[custom.name] = new Module(this)
        }

        this.api = new Api(this)
        await this.__initStore()
        this.telemetry = new Telemetry(this)
        // Clear all state if the schema changed after a plugin update.
        // This is done here because of translations, which are only available
        // after initializing Vue.
        const validSchema = this.store.validSchema()
        let notification = {message: null, title: null}
        // Only send a notification when the schema is already defined and invalid.
        if (validSchema === false) {
            notification.message = this.$t('this update requires you to re-login and setup your account again; our apologies.')
            notification.title = this.$t('database schema changed')
        }

        if (!validSchema) this.__factoryDefaults(notification)
        this.emit('ready')
    }


    /**
    * Load custom platform data and optionally connect to
    * a calling service backend. Only use this method on
    * an authenticated user.
    * @param {Boolean} callService - Whether to initialize the calling service.
    * @param {Boolean} contacts - Whether to subsribe to Contact Presence.

    */
    __initServices(callService = false) {
        this.logger.info(`${this}init connectivity services (callservice: ${callService ? 'yes' : 'no'})`)
        if (this.state.app.online) {
            if (callService) {
                this.modules.calls.connect({register: this.state.settings.webrtc.enabled})
            }
        }

        this.setState({ui: {menubar: {event: null}}})
        this._platformData()

    }


    /**
    * Setup a store for a new or previously stored session.
    * @param {Object} [options] - options.
    * @param {String} [options.username] - The username to unlock the store with.
    * @param {String} [options.password] - The password to unlock the store with.
    */
    async __initSession({key = null, username = null, password = null} = {}) {
        if (key) {
            this.logger.info(`${this}init session for an exsting vault...`)
            await this.crypto._importVaultKey(key)
        } else if (username && password) {
            this.logger.debug(`${this}init session with credentials...`)
            await this.crypto.initIdentity(username, password)
        } else {
            throw new Error('failed to unlock (no session key or credentials)')
        }

        await this._restoreState(username)
        this.setState({
            app: {vault: {unlocked: true}},
            user: {authenticated: true},
        }, {encrypt: false, persist: true})

        // Set the default layer if it's still set to login.
        if (this.state.ui.layer === 'login') {
            this.setState({ui: {layer: 'calls'}}, {encrypt: false, persist: true})
        }

        // Store the vault key on login when the setting is on,
        //but the key is not there yet.
        const vault = this.state.app.vault
        if (vault.store && !vault.key) {
            await this.crypto.storeVaultKey()
        }
        // Get a fresh reference to the media permission on unlock.
        this.__initMedia()
        this.emit('bg:user-unlocked', {}, true)
    }



    /**
    * Load store defaults and restore the encrypted state from
    * localStorage, if the session can be restored immediately.
    * Load a clean state from defaults otherwise. Then initialize
    * the ViewModel and check for the data schema. Do a factory reset
    * if the data schema is outdated.
    */
    async __initStore() {
        this.logger.info(`${this}init store...`)
        super.__initStore()
        this.setSession('active')
        // Setup HTTP client without authentication when there is a store.
        this.api.setupClient()
        // The vault always starts in a locked position.
        this.setState({
            app: {vault: {unlocked: false}},
            ui: {menubar: {base: 'inactive', event: null}},
        })

        if (this.state.app.vault.key) {
            this.logger.info(`${this}continuing existing session '${this.state.user.username}'...`)
            await this.__initSession({key: this.state.app.vault.key, username: this.state.user.username})
            // The API username and token are now available in the store.
            this.api.setupClient(this.state.user.username, this.state.user.token)
            // (!) State is reactive after initializing the view-model.
            await this.__initViewModel()

            this.__storeWatchers(true)
            this.__initServices(true)
        } else {
            // No session yet.
            await this.__initViewModel()
        }

        this.devices = new Devices(this)

        // Signal all modules that AppBackground is ready to go.
        for (let module of Object.keys(this.modules)) {
            if (this.modules[module]._ready) this.modules[module]._ready()
        }
    }


    /**
    * App state merge operation with additional optional state storage.
    * The busy flag and queue make sure that merge operations are done
    * sequently. Multiple requests can come in from events; each should
    * be processed one at a time.
    * @param {Object} options - See the parameter description of super.
    */
    async __mergeState({action = 'upsert', encrypt = true, index, path = null, persist = false, reject, resolve, state}) {
        this.__mergeQueue[index].status = 1
        const storeEndpoint = this.state.user.username
        // This could happen when an action is still queued, while the user
        // is logging out at the same moment. The action is then ignored.
        if (persist && !storeEndpoint) return
        // Flag that the operation is currently in use.
        super.__mergeState({action, encrypt, path, persist, state})

        if (!persist) {
            this.__mergeQueue[index].status = 2
            resolve()
            if (this.__mergeQueue[index + 1]) this.__mergeQueue[index + 1].action()
            return
        }

        // Background is leading and is the only one that
        // writes to storage using encryption.
        let storeKey = encrypt ? `${storeEndpoint}/state/vault` : `${storeEndpoint}/state`
        let storeState = this.store.get(storeKey)

        if (storeState) {
            if (encrypt) {
                storeState = JSON.parse(await this.crypto.decrypt(this.crypto.sessionKey, storeState))
            }
        } else storeState = {}

        // Store specific properties in a nested key path.
        if (path) {
            path = path.split('.')
            const _ref = path.reduce((o, i)=>o[i], storeState)
            this.__mergeDeep(_ref, state)
        } else {
            this.__mergeDeep(storeState, state)
        }

        // Encrypt the updated store state.
        if (encrypt) {
            storeState = await this.crypto.encrypt(this.crypto.sessionKey, JSON.stringify(storeState))
        }

        this.store.set(storeKey, storeState)
        // The item may already been cleaned up.
        if (this.__mergeQueue[index]) this.__mergeQueue[index].status = 2
        resolve()

        if (this.__mergeQueue[index + 1]) this.__mergeQueue[index + 1].action()
    }


    /**
    * set state like in the foreground, but since storage/encryption
    * is async, we resolve this call at the moment the particular action
    * is resolved. Each item in the merge queue is processed in order.
    * @returns {Promise} - Resolves when the state action has been processed.
    */
    __mergeStateQueue({action, encrypt, path, persist, state}) {
        return new Promise((resolve, reject) => {
            const index = this.__mergeIndex
            this.__mergeIndex += 1
            let startQueue = false
            let startItem = null

            this.__mergeQueue[index] = {
                action: () => this.__mergeState({action, encrypt, index, path, persist, reject, resolve, state}),
                status: 0,
            }

            for (const i of Object.keys(this.__mergeQueue)) {
                // A queue item is already executing.
                if (this.__mergeQueue[i].status === 0) {
                    startQueue = true
                    if (!startItem) startItem = i
                } else if (this.__mergeQueue[i].status === 2) {
                    delete this.__mergeQueue[i]
                }
            }

            if (startQueue) this.__mergeQueue[startItem].action()
        })
    }


    /**
    * Watchers are added to the store, so application logic can be
    * data-orientated (centralized around store properties), instead
    * of having to spinkle the same reference to logic at each location
    * where the store property is changed. Use with care, since it can
    * introduce unpredicatable behaviour; especially in combination with
    * multiple async setState calls.
    * @param {Boolean} [activate=True] - Activates or deactivates watchers.
    */
    __storeWatchers(activate = true) {
        if (!activate) {
            this.logger.info(`${this}deactivating ${this._watchers.length} store watchers`)
            for (const unwatch of this._watchers) unwatch()
            this._watchers = []
        } else {
            this.logger.info(`${this}init store watchers...`)
            let watchers = {}

            for (let module of Object.keys(this.modules)) {
                if (this.modules[module]._watchers) {
                    Object.assign(watchers, this.modules[module]._watchers())
                }
            }

            for (const key of Object.keys(watchers)) {
                this._watchers.push(this.vm.$watch(key, watchers[key]))
            }
        }
    }


    /**
    * Refresh data from the API endpoints for each module.
    */
    async _platformData() {
        this.logger.info(`${this}<platform> refreshing all data`)
        const dataModules = Object.keys(this.modules).filter((m) => this.modules[m]._platformData)
        await Promise.all(dataModules.map((m) => this.modules[m]._platformData()))
        if (this.state.settings.wizard.completed) this.modules.contacts.subscribe()
    }


    /**
    * The stored state is separated between two serialized JSON objects
    * in localStorage. One is for encrypted data, and the other for
    * unencrypted data. When the application needs to retrieve its state
    * from storage, this method will restore the combined state
    * and applies module-specific state changes. See for instance the
    * _restoreState implementation in the Contacts module for a more
    * complicated example.
    * @param {String} sessionId - The username/session to restore the state for.
    */
    async _restoreState(sessionId) {
        this.logger.debug(`${this}restore state for session ${sessionId}`)
        let cipherData = this.store.get(`${sessionId}/state/vault`)
        let unencryptedState = this.store.get(`${sessionId}/state`)
        if (!unencryptedState) unencryptedState = {}

        let decryptedState = {}
        // Determine if there is an encrypted state vault.
        if (cipherData) {
            this.logger.debug(`${this}restoring encrypted vault session ${sessionId}`)
            decryptedState = JSON.parse(await this.crypto.decrypt(this.crypto.sessionKey, cipherData))
        } else decryptedState = {}

        let state = {}

        this.__mergeDeep(state, decryptedState, unencryptedState)

        for (let module of Object.keys(this.modules)) {
            if (this.modules[module]._restoreState) {
                // Nothing persistent in this module yet. Assume an empty
                // object to start with.
                if (!state[module]) state[module] = {}
                this.modules[module]._restoreState(state[module])
            }
        }

        this.setState(state)
    }


    /**
    * Remove a session with a clean state.
    * @param {String} sessionId - The identifier of the session.
    */
    removeSession(sessionId) {
        this.logger.info(`${this}removing session '${sessionId}'`)
        this.store.remove(`${sessionId}/state`)
        this.store.remove(`${sessionId}/state/vault`)
        this.setSession('new')
    }


    /**
    * Reboot a session with a clean state. It can be used
    * to load a specific previously stored session, or to
    * continue the session that should be active or to
    * start a `new` session.
    * @param {String} sessionId - The identifier of the session.
    * @param {Object} keptState - State that needs to survive.
    */
    setSession(sessionId = 'new', keptState = {}) {
        let session = this.store.findSessions()
        if (sessionId === 'active') {
            sessionId = session.active ? session.active : 'new'
            this.logger.debug(`${this}active session requested, found "${sessionId}"`)
        }

        this.logger.debug(`${this}set session '${sessionId}'`)
        // Make sure there are no watchers left.
        if (this._watchers.length) this.__storeWatchers(false)
        // Overwrite the current state with the initial state.
        Object.assign(this.state, this._initialState(), keptState)

        if (sessionId && sessionId !== 'new') {
            this.__mergeDeep(this.state, this.store.get(`${sessionId}/state`))
            // Always pin these presets, no matter what the stored setting is.

            if (this.state.app.vault.key) {
                this.state.app.vault.unlocked = true
            } else {
                this.state.app.vault.unlocked = false
            }
            this.modules.ui.menubarState()
            Object.assign(this.state.user, {authenticated: false, username: sessionId})
        }

        this.state.app.session = session
        // Set the active session.
        if (sessionId && sessionId !== 'new') {
            this.state.app.session.active = sessionId
        }

        this.setState(this.state)
        this.modules.ui.menubarState()
    }


    /**
    * Set the state within the own running script context
    * and then propagate the state to the other logical
    * endpoint for syncing.
    * @param {Object} state - The state to update.
    * @param {Boolean} options - Whether to persist the changed state to localStorage.
    */
    async setState(state, {action, encrypt, path, persist} = {}) {
        if (!action) action = 'upsert'
        // Merge state in the context of the executing script.
        await this.__mergeStateQueue({action, encrypt, path, persist, state})
        // Sync the state to the other script context(bg/fg).
        // Make sure that we don't pass a state reference over the
        // EventEmitter in case of a webview; this would create
        // unpredicatable side-effects.
        let stateClone = state
        if (!this.env.isExtension) stateClone = JSON.parse(JSON.stringify(state))
        this.emit('fg:set_state', {action, encrypt, path, persist, state: stateClone})
        return
    }


    /**
    * Generate a representational name for this module. Used for logging.
    * @returns {String} - An identifier for this module.
    */
    toString() {
        return '[bg] '
    }
}

let bgOptions = {
    env,
    modules: {
        builtin: [
            {module: require('./modules/activity'), name: 'activity'},
            {module: require('./modules/app'), name: 'app'},
            {
                adapter: process.env.MOD_AVAILABILITY_ADAPTER,
                module: require('./modules/availability'),
                name: 'availability',
            },
            {module: require('./modules/calls'), name: 'calls'},
            {
                module: require('./modules/contacts'),
                name: 'contacts',
                providers: process.env.MOD_CONTACTS_PROVIDERS,
            },
            {module: require('./modules/settings'), name: 'settings'},
            {module: require('./modules/ui'), name: 'ui'},
            {
                adapter: process.env.MOD_USER_ADAPTER,
                module: require('./modules/user'),
                name: 'user',
            },
        ],
        custom: process.env.MOD_CUSTOM_BG,
    },
}

if (env.isBrowser) {
    if (env.isExtension) {
        bgOptions.modules.builtin.push({module: require('./modules/extension'), name: 'extension'})
        Raven.context(function() {
            this.bg = new AppBackground(bgOptions)
        })
    } else {
        global.AppBackground = AppBackground
        global.bgOptions = bgOptions
    }
} else {
    module.exports = {AppBackground, bgOptions}
}
