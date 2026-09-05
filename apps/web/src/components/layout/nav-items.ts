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
  Inbox,
  Calculator,
  Calendar,
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
      { href: '/accounts', label: 'Счета', icon: Wallet },
      { href: '/suppliers', label: 'Поставщики', icon: Truck },
      { href: '/counterparties', label: 'Контрагенты', icon: Users },
      { href: '/categories', label: 'Категории', icon: Tag },
      { href: '/reports/rules', label: 'Правила', icon: Filter },
      { href: '/transfers', label: 'Переводы', icon: ArrowLeftRight },
      { href: '/import', label: 'Импорт', icon: Upload },
      { href: '/integrations', label: 'Интеграции', icon: Plug },
      { href: '/reconciliation', label: 'Сверка', icon: Scale },
      { href: '/health', label: 'Здоровье', icon: Alarm },
      { href: '/audit', label: 'Аудит', icon: History },
    ],
  },
];

/** Flat list for breadcrumb-label lookups by exact href. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
