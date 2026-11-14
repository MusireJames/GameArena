package com.gamearena.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

/** GameArena: a full-screen shell that loads your hosted site. The site address is asked once on first launch. */
public class MainActivity extends Activity {
  private WebView web;
  private ProgressBar bar;
  private String base;
  private AlertDialog dialog;
  private long lastBack;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF1A1A18);
    web = new WebView(this);
    web.setBackgroundColor(0xFF1A1A18);
    root.addView(web, new FrameLayout.LayoutParams(-1, -1));
    bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    bar.setMax(100);
    bar.setVisibility(View.GONE);
    root.addView(bar, new FrameLayout.LayoutParams(-1, 8));
    setContentView(root);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setUserAgentString(s.getUserAgentString() + " GameArenaApp/1.0");
    CookieManager.getInstance().setAcceptCookie(true);

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onProgressChanged(WebView v, int p) {
        bar.setProgress(p);
        bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        Uri u = r.getUrl();
        String sch = u.getScheme();
        if (("http".equals(sch) || "https".equals(sch)) && sameSite(u)) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
        return true;
      }

      @Override
      public void onPageStarted(WebView v, String url, Bitmap icon) {
        bar.setVisibility(View.VISIBLE);
      }

      @Override
      public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
        if (r.isForMainFrame()) showError();
      }
    });

    base = prefs().getString("url", null);
    if (base == null) askAddress(); else web.loadUrl(base);
  }

  private SharedPreferences prefs() { return getSharedPreferences("gamearena", MODE_PRIVATE); }

  private boolean sameSite(Uri u) {
    String h = Uri.parse(base == null ? "" : base).getHost();
    return h != null && h.equalsIgnoreCase(u.getHost());
  }

  private AlertDialog.Builder builder() {
    return new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert);
  }

  private void askAddress() {
    if (dialog != null && dialog.isShowing()) dialog.dismiss();
    final EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    input.setSingleLine(true);
    input.setHint("https://yourdomain.com");
    input.setText(base == null ? "https://" : base);
    input.setSelection(input.getText().length());
    FrameLayout box = new FrameLayout(this);
    int pad = (int) (20 * getResources().getDisplayMetrics().density);
    box.setPadding(pad, pad / 2, pad, 0);
    box.addView(input);
    AlertDialog.Builder b = builder()
        .setTitle("GameArena address")
        .setMessage("Enter the web address of your GameArena site.")
        .setView(box)
        .setCancelable(base != null)
        .setPositiveButton("Open", new DialogInterface.OnClickListener() {
          @Override
          public void onClick(DialogInterface d, int w) { save(input.getText().toString()); }
        });
    if (base != null) b.setNegativeButton("Cancel", null);
    dialog = b.show();
  }

  private void save(String raw) {
    String v = raw.trim();
    if (v.length() == 0) { askAddress(); return; }
    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://" + v;
    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
    if (Uri.parse(v).getHost() == null) {
      Toast.makeText(this, "That address does not look right", Toast.LENGTH_LONG).show();
      askAddress();
      return;
    }
    base = v;
    prefs().edit().putString("url", v).apply();
    web.loadUrl(v);
  }

  private void showError() {
    if (isFinishing() || (dialog != null && dialog.isShowing())) return;
    dialog = builder()
        .setTitle("Can't reach GameArena")
        .setMessage("Check your internet connection.\n\nSite address:\n" + base)
        .setCancelable(false)
        .setPositiveButton("Retry", new DialogInterface.OnClickListener() {
          @Override
          public void onClick(DialogInterface d, int w) { web.loadUrl(base); }
        })
        .setNeutralButton("Change address", new DialogInterface.OnClickListener() {
          @Override
          public void onClick(DialogInterface d, int w) { askAddress(); }
        })
        .setNegativeButton("Exit", new DialogInterface.OnClickListener() {
          @Override
          public void onClick(DialogInterface d, int w) { finish(); }
        })
        .show();
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) { web.goBack(); return; }
    long now = System.currentTimeMillis();
    if (now - lastBack < 2000) { finish(); return; }
    lastBack = now;
    Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show();
  }

  @Override
  protected void onPause() { super.onPause(); web.onPause(); CookieManager.getInstance().flush(); }

  @Override
  protected void onResume() { super.onResume(); web.onResume(); }
}
