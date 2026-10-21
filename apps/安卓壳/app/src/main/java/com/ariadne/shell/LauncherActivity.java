package com.ariadne.shell;

import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

/**
 * A1：双地址入口 + 摄像头占位。无相机权限。
 */
public class LauncherActivity extends AppCompatActivity {

    private TextInputEditText inputHome;
    private TextInputEditText inputTail;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_launcher);

        inputHome = findViewById(R.id.inputHome);
        inputTail = findViewById(R.id.inputTail);
        MaterialButton btnSave = findViewById(R.id.btnSave);
        MaterialButton btnHome = findViewById(R.id.btnHome);
        MaterialButton btnTail = findViewById(R.id.btnTail);
        MaterialButton btnCamera = findViewById(R.id.btnCameraStub);

        inputHome.setText(Prefs.getHomeUrl(this));
        inputTail.setText(Prefs.getTailUrl(this));

        btnSave.setOnClickListener(v -> {
            Prefs.save(this, textOf(inputHome), textOf(inputTail));
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
        });

        btnHome.setOnClickListener(v -> openUrl(textOf(inputHome), Prefs.CHOICE_HOME));
        btnTail.setOnClickListener(v -> openUrl(textOf(inputTail), Prefs.CHOICE_TAIL));

        btnCamera.setOnClickListener(
                v -> Toast.makeText(this, R.string.camera_stub_toast, Toast.LENGTH_LONG).show());
    }

    private static String textOf(TextInputEditText edit) {
        return edit.getText() == null ? "" : edit.getText().toString().trim();
    }

    private void openUrl(String url, String choice) {
        Prefs.save(this, textOf(inputHome), textOf(inputTail));
        if (TextUtils.isEmpty(url)) {
            Toast.makeText(this, R.string.err_empty_url, Toast.LENGTH_LONG).show();
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        Prefs.setLastChoice(this, choice);
        Intent i = new Intent(this, WebViewActivity.class);
        i.putExtra(WebViewActivity.EXTRA_URL, url);
        startActivity(i);
    }
}
