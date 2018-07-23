module.exports = (app) => {
    /**
    * @memberof fg.components
    */
    const MainMenubar = {
        computed: app.helpers.sharedComputed(),
        data: function() {
            return {
                customModules: app.modules,
            }
        },
        methods: Object.assign({
            classes: function(block, transferHint) {
                let classes = {}
                // We assume here that a block is always an option. Change
                // this logic if other kind of blocks are required.
                classes.active = (this.layer === block)

                if (block === 'activity') {
                    classes.unread = this.unread
                } else if (block === 'availability') {
                    if (this.dnd) classes.dnd = true
                    else if (this.available) classes.available = true
                    else classes.unavailable = true
                } else if (block === 'calls') {
                    classes.disabled = !this.app.online
                    classes['calls-active'] = this.callOngoing
                } else if (transferHint) {
                    classes.hint = (this.transferStatus === 'select')
                }

                return classes
            },
            logout: app.helpers.logout,
        }, app.helpers.sharedMethods()),
        render: templates.main_menubar.r,
        staticRenderFns: templates.main_menubar.s,
        store: {
            app: 'app',
            available: 'availability.available',
            dnd: 'availability.dnd',
            layer: 'ui.layer',
            unread: 'activity.unread',
        },
    }

    return MainMenubar
}
