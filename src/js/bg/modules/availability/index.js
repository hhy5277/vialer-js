/**
* VoIPGRID-platform specific functionality. Within the platform, it is
* possible to set a user's availability. This has effect when the
* user is part of a dialplan and can be used to dynamically switch
* between endpoints.
* @module ModuleAvailability
*/
const Module = require('../../lib/module')


/**
* Main entrypoint for Availability.
* @memberof AppBackground.modules
*/
class ModuleAvailability extends Module {
    /**
    * @param {AppBackground} app - The background application.
    * @param {AvailabilityProvider} AvailabilityAdapter - The Availability adapter to use.
    */
    constructor(app, AvailabilityAdapter) {
        super(app)

        if (AvailabilityAdapter) {
            this.adapter = new AvailabilityAdapter(app)
            this.app.on('bg:availability:platform_data', this.adapter._platformData.bind(this))
            this.app.on('bg:availability:update', this.adapter._updateAvailability.bind(this))
        }
    }


    /**
    * Initializes the module's store.
    * Notice that the `sud` property is used to keep track of the
    * selecteduserdestination API endpoint reference.
    * @returns {Object} The module's store properties.
    */
    _initialState() {
        let adapterState
        if (this.adapter) adapterState = this.adapter._initialState()
        else adapterState = {}

        return Object.assign({
            available: false,
            dnd: false,
            voip: {
                // Determined at build time and used to switch endpoint
                // input on for the user.
                endpoint: Boolean(process.env.SIP_ENDPOINT),
                selection: Array.isArray(adapterState.phoneaccounts),
            },
        }, adapterState)
    }


    /**
    * Call for platform data from the provider.
    */
    async _platformData() {
        if (this.adapter) await this.adapter._platformData()
    }


    /**
    * Setup availability-specific store watchers.
    * @param {Boolean} dndEnabled - Whether do-not-disturb is being enabled.
    * @returns {Object} - Properties that need to be watched.
    */
    _watchers() {
        let adapterWatchers
        if (this.adapter && this.adapter._watchers) adapterWatchers = this.adapter._watchers()
        return Object.assign({
            'store.availability.dnd': (dndEnabled) => {
                this.app.modules.ui.menubarState()
            },
        }, adapterWatchers)
    }


    /**
    * Generate a representational name for this module. Used for logging.
    * @returns {String} - An identifier for this module.
    */
    toString() {
        return `${this.app}[availability] `
    }
}

module.exports = ModuleAvailability
