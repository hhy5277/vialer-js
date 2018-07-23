module.exports = (app) => {
    /**
    * @memberof fg.components
    */
    const MainStatusbar = {
        computed: app.helpers.sharedComputed(),
        methods: Object.assign({
            classes: function(block) {
                let classes = {}
                if (block === 'component') {
                    if (!this.user.authenticated) classes.ok = true
                    else {
                        if (this.settings.webrtc.enabled) {
                            if (!this.settings.webrtc.media.permission) classes.error = true
                            else if (!this.settings.webrtc.devices.ready) classes.error = true
                            else if (this.ua.status !== 'registered') classes.error = true
                            else if (this.dnd) classes.warning = true
                            else if (this.ua.status === 'registered') classes.ok = true
                        } else {
                            if (this.ua.status !== 'connected') classes.error = true
                            else classes.ok = true
                        }
                    }
                }
                return classes
            },
            logout: app.helpers.logout,
            refreshApiData: function() {
                if (!this.app.online) return
                app.notify({icon: 'refresh', message: `${app.$t('application data reloaded')}...`, type: 'success'})
                app.emit('bg:refresh_api_data')
                app.emit('bg:calls:disconnect', {reconnect: true})
            },
            titles: function(block) {
                let title = ''
                if (block === 'indicator') {
                    if (this.settings.webrtc.enabled) title += 'WebRTC: '
                    else title += 'ConnectAB: '

                    if (['disconnected', 'reconnect', 'registration_failed'].includes(this.ua.status)) {
                        // Give an indication why we are not connected.
                        if (!this.app.online) title += this.$t('offline')
                        else if (this.ua.status === 'registration_failed') {
                            title += this.$t('registration failed')
                        } else title += this.$t('no connection')
                    } else {
                        if (this.settings.webrtc.enabled) {
                            if (this.ua.status === 'registered') {
                                if (!this.settings.webrtc.media.permission) {
                                    title += this.$t('no microphone access')
                                } else if (!this.settings.webrtc.devices.ready) {
                                    title += this.$t('invalid audio device')
                                } else {
                                    title += this.$t('registered')
                                    if (this.dnd) title += ` (${this.$t('do not disturb')})`
                                }
                            } else {
                                if (this.ua.status === 'connected') {
                                    title += this.$t('connected')
                                } else {
                                    title += this.$t('not registered')
                                }
                            }
                        } else {
                            if (this.ua.status === 'connected') {
                                title += this.$t('connected')
                            } else {
                                title += this.$t(this.ua.status)
                            }
                        }
                    }

                    if (this.selected.username) {
                        title += ` (${this.selected.username})`
                    } else {
                        title += ` (${this.$t('no account')})`
                    }
                }

                return title
            },
        }, app.helpers.sharedMethods()),
        render: templates.main_statusbar.r,
        staticRenderFns: templates.main_statusbar.s,
        store: {
            app: 'app',
            dnd: 'availability.dnd',
            env: 'env',
            layer: 'ui.layer',
            selected: 'settings.webrtc.account.selected',
            settings: 'settings',
            ua: 'calls.ua',
            user: 'user',
            vendor: 'app.vendor',
        },
    }

    return MainStatusbar
}
