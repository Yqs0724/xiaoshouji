package com.ariadne.shell;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * 注入到 WebView：PWA 读真机电量（浏览器 Battery API 多数已废）。
 */
public final class ShellBridge {
    private final Context app;

    public ShellBridge(Context context) {
        this.app = context.getApplicationContext();
    }

    @JavascriptInterface
    public String getBattery() {
        try {
            IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent bat = app.registerReceiver(null, filter);
            int level = -1;
            int scale = 100;
            int status = BatteryManager.BATTERY_STATUS_UNKNOWN;
            if (bat != null) {
                level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                status = bat.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN);
            }
            double pct = 0;
            if (level >= 0 && scale > 0) {
                pct = Math.max(0, Math.min(1, level / (double) scale));
            }
            boolean charging =
                    status == BatteryManager.BATTERY_STATUS_CHARGING
                            || status == BatteryManager.BATTERY_STATUS_FULL;
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("level", pct);
            o.put("charging", charging);
            o.put("source", "android");
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"level\":null,\"charging\":false,\"source\":\"error\"}";
        }
    }
}
