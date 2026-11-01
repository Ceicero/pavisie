package com.careercrumbs.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

// Test build: the CareerCrumbs page in a full-screen WebView, saving to the phone.
public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Job posting links open in the browser, not inside the app.
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    return true;
                }
                return false;
            }
        });
        web.addJavascriptInterface(new Bridge(), "CCAndroid");
        if (state != null) web.restoreState(state);
        else web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // Called from the page as window.CCAndroid.*
    private class Bridge {
        @JavascriptInterface
        public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("CareerCrumbs", text));
        }

        // Saves to Downloads. Calendar files then open in the calendar app to add the reminders.
        @JavascriptInterface
        public String saveFile(final String name, final String data) {
            final boolean calendar = name.endsWith(".ics");
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime(name));
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        os.write(data.getBytes(StandardCharsets.UTF_8));
                    }
                    final Uri saved = uri;
                    runOnUiThread(() -> {
                        if (calendar) {
                            Intent i = new Intent(Intent.ACTION_VIEW);
                            i.setDataAndType(saved, "text/calendar");
                            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            try {
                                startActivity(i);
                                return;
                            } catch (Exception e) {
                                Toast.makeText(MainActivity.this, "Saved to Downloads. Open it with your calendar app.", Toast.LENGTH_LONG).show();
                                return;
                            }
                        }
                        Toast.makeText(MainActivity.this, "Saved to Downloads: " + name, Toast.LENGTH_SHORT).show();
                    });
                    return "saved";
                } catch (Exception e) {
                    // Fall through to sharing the text instead.
                }
            }
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, name);
                i.putExtra(Intent.EXTRA_TEXT, data);
                startActivity(Intent.createChooser(i, "Save " + name));
            });
            return "shared";
        }

        private String mime(String name) {
            if (name.endsWith(".ics")) return "text/calendar";
            if (name.endsWith(".json")) return "application/json";
            return "text/plain";
        }
    }
}
