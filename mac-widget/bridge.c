#include <node_api.h>

extern void reloadArgusWidgetTimelines(void);

static napi_value reload(napi_env env, napi_callback_info info) {
    reloadArgusWidgetTimelines();
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

NAPI_MODULE_INIT() {
    napi_value callback;
    if (napi_create_function(env, "reload", NAPI_AUTO_LENGTH, reload, NULL, &callback) != napi_ok ||
        napi_set_named_property(env, exports, "reload", callback) != napi_ok) {
        napi_throw_error(env, NULL, "Could not initialize the WidgetKit bridge.");
        return NULL;
    }
    return exports;
}
