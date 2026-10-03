import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

const API = 'http://localhost:3001';
type Language = 'en' | 'hi';
interface Beat { start: number; end: number; text: string; }
interface Script {
  summary: string; hook: string; language: Language; beats: Beat[];
  metadata: { title: string; description: string; tags: string[] };
}
interface Options {
  language: Language; geminiModel: string;
  tone: 'funny' | 'curious' | 'wholesome';
  watermark: string; opacity: number;
  captions: boolean; cta: boolean; originalAudio: boolean; coverOriginalCaptions: boolean;
  fit: 'fill' | 'contain'; voiceId: string; review: boolean;
}
interface Job {
  id: string;
  scriptRevision?: number;
  hasAnalysis?: boolean;
  status: 'uploading' | 'analyzing' | 'review' | 'regenerating' | 'rendering' | 'done' | 'error';
  step: string; percent: number; error?: string | null;
  info?: { duration: number; width: number; height: number };
  script?: Script | null;
  videoUrl?: string | null; captionsUrl?: string | null;
  metadataUrl?: string | null;
}
interface Voice {
  id: string; name: string; language: Language;
  locale: string; native: boolean; gender?: string;
}
interface Health {
  ok: boolean; ffmpeg: boolean; geminiConfigured: boolean;
  cartesiaConfigured: boolean; geminiModel: string; geminiModels: string[];
  defaultVoice: string; hindiVoice: string;
  maxDuration: number; maxUploadMB: number;
}

@Component({
  selector: 'app-root', standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  file: File | null = null;
  localPreview = '';
  dragging = false;
  busy = false;
  fetchingVoices = false;
  apiError = '';
  toast = '';
  job: Job | null = null;
  health: Health | null = null;
  voices: Voice[] = [];
  showAdvanced = false;
  timer: ReturnType<typeof setInterval> | null = null;
  options: Options = {
    language: 'en', geminiModel: 'gemini-3.5-flash-lite',
    tone: 'funny', watermark: 'MyShortsChannel', opacity: 44,
    captions: true, cta: true, originalAudio: false, coverOriginalCaptions: false,
    fit: 'fill', voiceId: '', review: false
  };

  get filteredVoices(): Voice[] {
    return this.voices.filter(v => v.language === this.options.language);
  }
  get selectedVoiceValid(): boolean {
    return this.filteredVoices.some(v => v.id === this.options.voiceId);
  }
  get ready(): boolean {
    return !!(
      this.health?.ffmpeg && this.health.geminiConfigured &&
      this.health.cartesiaConfigured && this.selectedVoiceValid
    );
  }
  get processing(): boolean {
    return !!this.job && ['uploading', 'analyzing', 'regenerating', 'rendering'].includes(this.job.status);
  }
  get canRegenerate(): boolean {
    return !!this.job?.hasAnalysis && ['review','done','error'].includes(this.job.status) && !this.busy && !this.processing && !!this.health?.geminiConfigured;
  }
  get backendConnected(): boolean { return !!this.health?.ok; }
  get downloadUrl(): string { return this.job?.videoUrl ? API + this.job.videoUrl : ''; }

  ngOnInit(): void { void this.checkHealth(); }
  ngOnDestroy(): void {
    this.stopPolling();
    if (this.localPreview) URL.revokeObjectURL(this.localPreview);
  }

  async checkHealth(): Promise<void> {
    try {
      const r = await fetch(`${API}/api/health`);
      if (!r.ok) throw new Error('Backend returned an error');
      this.health = await r.json() as Health;
      if (
        this.health.geminiModels?.length &&
        !this.health.geminiModels.includes(this.options.geminiModel)
      ) this.options.geminiModel = this.health.geminiModel;
      this.apiError = '';
      if (this.health.cartesiaConfigured) await this.loadVoices();
    } catch (e) {
      this.health = null;
      this.apiError = `Backend unavailable: ${this.errorText(e)}`;
    }
  }

  async loadVoices(): Promise<void> {
    this.fetchingVoices = true;
    try {
      const r = await fetch(`${API}/api/voices`, { cache: 'no-store' });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || 'Could not load voices');
      const results: Voice[] = Array.isArray(payload.voices) ? payload.voices : [];
      this.voices = results.filter(v =>
        !!v.id && (v.language === 'hi' || v.language === 'en')
      );
      if (!this.selectedVoiceValid) {
        this.options.voiceId = this.filteredVoices[0]?.id || '';
      }
      if (!this.filteredVoices.length) {
        this.notify(`No ${this.options.language === 'hi' ? 'Hindi' : 'English'}-compatible Cartesia voices found.`);
      }
    } catch (e) {
      this.voices = [];
      this.options.voiceId = '';
      this.apiError = this.errorText(e);
    } finally {
      this.fetchingVoices = false;
    }
  }

  selectLanguage(language: Language): void {
    if (this.options.language === language) return;
    this.options.language = language;
    // Clear the previous-language voice BEFORE rendering or requesting TTS.
    this.options.voiceId = this.filteredVoices[0]?.id || '';
    if (!this.options.voiceId && !this.fetchingVoices) {
      void this.loadVoices();
    }
  }

  dropped(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    const f = event.dataTransfer?.files?.item(0);
    if (f) this.setFile(f);
  }
  browse(event: Event): void {
    const f = (event.target as HTMLInputElement).files?.item(0);
    if (f) this.setFile(f);
  }
  setFile(f: File): void {
    if (!/\.(mp4|mov|webm|mkv)$/i.test(f.name)) {
      this.notify('Upload MP4, MOV, WebM or MKV'); return;
    }
    if (this.health && f.size > this.health.maxUploadMB * 1048576) {
      this.notify(`Maximum upload is ${this.health.maxUploadMB} MB`); return;
    }
    if (this.localPreview) URL.revokeObjectURL(this.localPreview);
    this.file = f;
    this.localPreview = URL.createObjectURL(f);
    this.job = null; this.toast = '';
    this.stopPolling();
  }

  async create(review: boolean): Promise<void> {
    if (!this.file || this.busy || !this.ready) return;
    this.options.review = review;
    this.busy = true; this.apiError = ''; this.job = null;
    try {
      const name = this.file.name.toLowerCase();
      const mime = name.endsWith('.mov') ? 'video/quicktime'
        : name.endsWith('.mkv') ? 'video/x-matroska'
        : name.endsWith('.webm') ? 'video/webm' : 'video/mp4';
      const raw = new TextEncoder().encode(JSON.stringify(this.options));
      let binary = '';
      for (const n of raw) binary += String.fromCharCode(n);
      const encoded = btoa(binary)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const response = await fetch(`${API}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': mime, 'X-Options': encoded },
        body: this.file
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      this.job = data as Job;
      this.startPolling();
    } catch (e) { this.apiError = this.errorText(e); }
    finally { this.busy = false; }
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = setInterval(() => { void this.poll(); }, 1300);
    void this.poll();
  }
  private stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  private async poll(): Promise<void> {
    if (!this.job) return;
    try {
      const r = await fetch(`${API}/api/jobs/${this.job.id}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Polling failed');
      this.job = d as Job;
      if (['done', 'review', 'error'].includes(this.job.status)) this.stopPolling();
    } catch (e) { this.stopPolling(); this.apiError = this.errorText(e); }
  }

  async regenerateScript(): Promise<void> {
    if (!this.job || !this.canRegenerate) return;
    this.busy = true;
    this.apiError = '';
    try {
      const r = await fetch(`${API}/api/jobs/${this.job.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: this.options })
      });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || 'Script regeneration failed');
      this.job = payload as Job;
      this.notify('Creating a fresh story using the same video…');
      this.startPolling();
    } catch (e) {
      this.apiError = this.errorText(e);
    } finally {
      this.busy = false;
    }
  }

  async renderEdits(): Promise<void> {
    if (!this.job?.script || this.processing || !this.selectedVoiceValid) return;
    const j = this.job;
    this.apiError = ''; this.busy = true;
    try {
      const r = await fetch(`${API}/api/jobs/${j.id}/render`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: j.script, options: this.options })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Render failed');
      this.job = d as Job; this.startPolling();
    } catch (e) { this.apiError = this.errorText(e); }
    finally { this.busy = false; }
  }
  async copy(value: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notify(`${what} copied!`);
    } catch { this.notify('Clipboard requires HTTPS or localhost'); }
  }
  get tags(): string { return this.job?.script?.metadata.tags.join(', ') || ''; }
  set tags(value: string) {
    if (this.job?.script) this.job.script.metadata.tags =
      value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 15);
  }
  get fullScript(): string { return this.job?.script?.beats.map(x => x.text).join(' ') || ''; }
  errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
  notify(m: string): void { this.toast = m; }
  API_LINK(p: string | null | undefined): string { return p ? API + p : '#'; }
  bytes(x: number): string { return `${(x / 1048576).toFixed(1)} MB`; }
  seconds(t: number): string {
    const s = Math.round(t || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}
