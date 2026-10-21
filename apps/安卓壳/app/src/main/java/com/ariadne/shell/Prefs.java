package com.ariadne.shell;

import android.content.Context;
import android.content.SharedPreferences;

final class Prefs {
    private static final String NAME = "ariadne_shell";
    private static final String KEY_HOME = "url_home";
    private static final String KEY_TAIL = "url_tail";
    private static final String KEY_LAST = "last_choice";

    static final String CHOICE_HOME = "home";
    static final String CHOICE_TAIL = "tail";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static String getHomeUrl(Context c) {
        return sp(c).getString(KEY_HOME, "http://192.168.1.8:8787");
    }

    static String getTailUrl(Context c) {
        return sp(c).getString(KEY_TAIL, "");
    }

    static String getLastChoice(Context c) {
        return sp(c).getString(KEY_LAST, CHOICE_HOME);
    }

    static void save(Context c, String home, String tail) {
        sp(c)
                .edit()
                .putString(KEY_HOME, home == null ? "" : home.trim())
                .putString(KEY_TAIL, tail == null ? "" : tail.trim())
                .apply();
    }

    static void setLastChoice(Context c, String choice) {
        sp(c).edit().putString(KEY_LAST, choice).apply();
    }
}
