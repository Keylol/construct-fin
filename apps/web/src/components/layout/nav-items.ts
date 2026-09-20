import {
  Alarm,
  Banknote,
  Home,
  Receipt,
  Upload,
  Wallet,
  Tag,
  Users,
  BarChart3,
  Filter,
  ClipboardList,
  UserRound,
  Package,
  Truck,
  ShoppingCart,
  History,
  ArrowLeftRight,
  Scale,
  Plug,
  Handshake,
  Inbox,
  Calculator,
  Calendar,
  type LucideIcon,
} from '@/components/ui/icons';
import type { Role } from '@/lib/types';
import { isOwnerLike } from '@/lib/roles';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Только владельцу: технические разделы и настройки справочников (docs/roles.md). */
  ownerOnly?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
  /** Группа свёрнута по умолчанию: нужное редко не должно мешать ежедневному. */
  collapsible?: boolean;
}

// Порядок — это порядок работы, а не алфавит и не полнота охвата.
//
// Ежедневный круг занимает первый блок: деньги пришли (Входящие) → заказ
// (Заказы) → чем оплачено (Закупки) → что с деньгами (Операции, Отчёты).
// Всё остальное нужно раз в месяц или раз в жизнь и лежит под «Ещё»: раздел
// не удалён и доступен по прямой ссылке, но не отвлекает каждый день.
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: '/dashboard', label: 'Главная', icon: Home },
      { href: '/inbox', label: 'Входящие', icon: Inbox },
      { href: '/crm', label: 'amoCRM', icon: Handshake },
      { href: '/orders', label: 'Заказы', icon: ClipboardList },
      { href: '/purchases', label: 'Закупки', icon: ShoppingCart },
      { href: '/transactions', label: 'Операции', icon: Receipt },
      { href: '/clients', label: 'Клиенты', icon: UserRound },
      { href: '/reports', label: 'Отчёты', icon: BarChart3 },
    ],
  },
  {
    label: 'Ещё',
    collapsible: true,
    items: [
      { href: '/planning', label: 'Платежи', icon: Calendar },
      { href: '/tax', label: 'Налог', icon: Calculator },
      { href: '/salary', label: 'Зарплата', icon: Banknote },
      { href: '/warehouse', label: 'Склад', icon: Package },
      { href: '/accounts', label: 'Счета', icon: Wallet, ownerOnly: true },
      { href: '/suppliers', label: 'Поставщики', icon: Truck },
      { href: '/counterparties', label: 'Контрагенты', icon: Users, ownerOnly: true },
      { href: '/categories', label: 'Категории', icon: Tag, ownerOnly: true },
      { href: '/reports/rules', label: 'Правила', icon: Filter, ownerOnly: true },
      { href: '/transfers', label: 'Переводы', icon: ArrowLeftRight, ownerOnly: true },
      { href: '/import', label: 'Импорт', icon: Upload, ownerOnly: true },
      { href: '/integrations', label: 'Интеграции', icon: Plug, ownerOnly: true },
      { href: '/reconciliation', label: 'Сверка', icon: Scale, ownerOnly: true },
      { href: '/health', label: 'Здоровье', icon: Alarm, ownerOnly: true },
      { href: '/audit', label: 'Аудит', icon: History, ownerOnly: true },
    ],
  },
];

/** Flat list for breadcrumb-label lookups by exact href. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Временно скрытые разделы (решение владельца 13.09.2026). Их нет в меню, в окне
 * «Разделы», в палитре, во вкладках отчётов, в таб-баре и в меню «Создать», а
 * прямой адрес отвечает «Раздел скрыт» (RoleGate) — для всех ролей. API, данные и
 * крон не тронуты: вернуть раздел — убрать адрес из списка. Пункты из NAV_GROUPS
 * не удаляются — на них держатся `isPathOwnerOnly` и крошки. Прежде чем скрыть
 * новый раздел, найдите grep'ом по адресу ссылки на него с других экранов
 * (плитки Главной, «Сделать сейчас», отчёты) и уберите эти переходы.
 */
export const HIDDEN_SECTIONS: readonly string[] = [
  '/health',
  '/suppliers',
  '/reports/budget',
];

/** Адрес ведёт в скрытый раздел: сам раздел, вложенный путь или ссылка с параметрами. */
export function isPathHidden(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  return HIDDEN_SECTIONS.some((h) => path === h || path.startsWith(`${h}/`));
}

/**
 * Меню для роли: оператору не показываем разделы `ownerOnly`, скрытые разделы —
 * никому. Один фильтр на боковую панель, окно «Ещё», палитру и вкладки отчётов —
 * чтобы раздел не пропадал в одном месте и оставался в другом.
 */
export function navGroupsFor(role: Role | null | undefined): NavGroup[] {
  const owner = isOwnerLike(role);
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !isPathHidden(i.href) && (owner || !i.ownerOnly)),
  })).filter((g) => g.items.length > 0);
}

/** Адрес закрыт для роли: экран `ownerOnly` или его вложенный путь. */
export function isPathOwnerOnly(pathname: string): boolean {
  return NAV_ITEMS.some(
    (i) => i.ownerOnly && (pathname === i.href || pathname.startsWith(`${i.href}/`)),
  );
}
