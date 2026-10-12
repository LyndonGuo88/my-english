package local.myenglish.reader;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeTts")
public class NativeTtsPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ready;
    private boolean initDone;
    private final Object gate = new Object();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            synchronized (gate) {
                ready = status == TextToSpeech.SUCCESS;
                if (ready) applyEnglish();
                initDone = true;
                gate.notifyAll();
            }
        });
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        waitUntilReady();
        if (!ready || tts == null) {
            call.reject("手机语音还没准备好");
            return;
        }
        String problem = applyEnglish();
        if (problem != null) {
            call.reject(problem);
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void speak(PluginCall call) {
        waitUntilReady();
        if (!ready || tts == null) {
            call.reject("手机语音还没准备好");
            return;
        }
        String text = call.getString("text", "");
        float rate = call.getFloat("rate", 1f);
        if (text.isEmpty()) {
            call.resolve();
            return;
        }
        String problem = applyEnglish();
        if (problem != null) {
            call.reject(problem);
            return;
        }
        tts.setSpeechRate(Math.max(0.1f, rate));
        String utteranceId = "utt-" + System.nanoTime();
        AtomicBoolean finished = new AtomicBoolean(false);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            private boolean mine(String id) {
                return utteranceId.equals(id);
            }

            private void finish() {
                if (finished.compareAndSet(false, true)) {
                    bridge.executeOnMainThread(call::resolve);
                }
            }

            private void fail() {
                if (finished.compareAndSet(false, true)) {
                    bridge.executeOnMainThread(() -> call.reject("朗读失败"));
                }
            }

            @Override
            public void onStart(String id) {}

            @Override
            public void onDone(String id) {
                if (mine(id)) finish();
            }

            @Override
            public void onError(String id) {
                if (mine(id)) fail();
            }

            @Override
            public void onStop(String id, boolean interrupted) {
                if (mine(id)) finish();
            }
        });
        Bundle params = new Bundle();
        params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId);
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        int queued = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
        if (queued == TextToSpeech.ERROR) {
            bridge.executeOnMainThread(() -> call.reject("朗读失败"));
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            tts.stop();
        }
        call.resolve();
    }

    private void waitUntilReady() {
        synchronized (gate) {
            long deadline = System.currentTimeMillis() + 4000;
            while (!initDone && System.currentTimeMillis() < deadline) {
                try {
                    gate.wait(200);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private String applyEnglish() {
        Voice voice = englishVoice();
        if (voice != null) {
            int voiceResult = tts.setVoice(voice);
            if (voiceResult == TextToSpeech.SUCCESS) return null;
        }
        int result = tts.setLanguage(Locale.US);
        if (supported(result)) return null;
        result = tts.setLanguage(Locale.ENGLISH);
        if (supported(result)) return null;
        String engine = tts.getDefaultEngine();
        if (engine == null || engine.isEmpty()) engine = "未设置";
        return "当前语音引擎没有英语语音（" + engine + "）。请在系统设置里打开这个引擎旁边的齿轮，下载英语语音后再试。";
    }

    private static boolean supported(int result) {
        return result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED;
    }

    private Voice englishVoice() {
        Set<Voice> voices;
        try {
            voices = tts.getVoices();
        } catch (RuntimeException error) {
            return null;
        }
        if (voices == null) return null;
        Voice fallback = null;
        for (Voice voice : voices) {
            Locale locale = voice.getLocale();
            if (locale == null || !"en".equalsIgnoreCase(locale.getLanguage())) continue;
            Set<String> features = voice.getFeatures();
            if (features != null && (features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
                    || features.contains("notInstalled"))) {
                continue;
            }
            if ("US".equalsIgnoreCase(locale.getCountry())) return voice;
            if (fallback == null) fallback = voice;
        }
        return fallback;
    }

    @Override
    public void handleOnDestroy() {
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
    }
}
