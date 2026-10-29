package com.ariadne.shell;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/**
 * 全屏加载 Ariadne PWA。麦克风权限若页面申请，由系统对话框处理；A1 不预申请。
 */
public class WebViewActivity extends AppCompatActivity {

    public static final String EXTRA_URL = "url";

    private WebView web;
    private ProgressBar progress;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_webview);

        web = findViewById(R.id.web);
        progress = findViewById(R.id.progress);

        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || url.trim().isEmpty()) {
            Toast.makeText(this, R.string.err_empty_url, Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        /* 允许本机网关 websocket */
        s.setAllowFileAccess(false);

        web.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return false;
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, Bitmap favicon) {
                        progress.setVisibility(View.VISIBLE);
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        progress.setVisibility(View.GONE);
                    }
                });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new ShellBridge(this), "AriadneShell");

        getOnBackPressedDispatcher()
                .addCallback(
                        this,
                        new OnBackPressedCallback(true) {
                            @Override
                            public void handleOnBackPressed() {
                                if (web.canGoBack()) {
                                    web.goBack();
                                } else {
                                    setEnabled(false);
                                    getOnBackPressedDispatcher().onBackPressed();
                                }
                            }
                        });

        web.loadUrl(url.trim());
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
