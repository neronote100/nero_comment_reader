import type {
  Analysis,
  Article,
  Candidate,
  Job,
  Member,
  MembershipEvent,
} from "./domain";
export interface Repository {
  members(): Promise<Member[]>;
  member(id: string): Promise<Member | null>;
  saveMember(member: Member): Promise<void>;
  event(event: MembershipEvent): Promise<void>;
  pendingEvents(): Promise<MembershipEvent[]>;
  resolveEvent(id: string, memberId: string): Promise<void>;
  applyEvent(event: MembershipEvent): Promise<void>;
  candidates(): Promise<Candidate[]>;
  article(id: string): Promise<Article | null>;
  saveArticle(article: Article): Promise<void>;
  saveAnalysis(
    article: Article,
    analysis: Analysis,
    model: string,
  ): Promise<void>;
  introduce(article: Article, publishedUrl: string): Promise<void>;
  setting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  enqueue(id: string, kind: string, target?: string): Promise<void>;
  claim(): Promise<Job | null>;
  finish(job: Job, error?: string): Promise<void>;
  jobs(): Promise<unknown[]>;
}
export interface NoteProvider {
  list(
    username: string,
    page: number,
  ): Promise<{ rows: Record<string, unknown>[]; last: boolean }>;
  detail(member: Member, row: Record<string, unknown>): Promise<Article>;
}
export interface AIProvider {
  analyze(article: Article): Promise<Analysis>;
}
export interface MailProvider {
  page(token?: string): Promise<{ events: MembershipEvent[]; next?: string }>;
}
