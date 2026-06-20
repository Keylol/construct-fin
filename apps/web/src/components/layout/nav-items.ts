import {
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
  History,
  ArrowLeftRight,
  Scale,
  type LucideIcon,
} from '@/components/ui/icons';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Главная', icon: Home }],
  },
  {
    label: 'Учёт',
    items: [
      { href: '/orders', label: 'Заказы', icon: ClipboardList },
      { href: '/transactions', label: 'Операции', icon: Receipt },
      { href: '/transfers', label: 'Переводы', icon: ArrowLeftRight },
      { href: '/import', label: 'Импорт', icon: Upload },
    ],
  },
  {
    label: 'Справочники',
    items: [
      { href: '/clients', label: 'Клиенты', icon: UserRound },
      { href: '/suppliers', label: 'Поставщики', icon: Truck },
      { href: '/warehouse', label: 'Склад', icon: Package },
      { href: '/accounts', label: 'Счета', icon: Wallet },
      { href: '/categories', label: 'Категории', icon: Tag },
      { href: '/counterparties', label: 'Контрагенты', icon: Users },
    ],
  },
  {
    label: 'Аналитика',
    items: [
      { href: '/reports', label: 'Отчёты', icon: BarChart3 },
      { href: '/reports/rules', label: 'Правила', icon: Filter },
      { href: '/reconciliation', label: 'Сверка', icon: Scale },
      { href: '/audit', label: 'Аудит', icon: History },
    ],
  },
];

/** Flat list for breadcrumb-label lookups by exact href. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
