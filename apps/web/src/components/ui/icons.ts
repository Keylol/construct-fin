/**
 * Единая точка иконок: Carbon (IBM) под именами, которые уже используются в коде.
 * Так миграция с lucide свелась к смене пути импорта, без правок мест использования.
 * Carbon-иконки рендерят <svg fill="currentColor"> (цвет — через text-*), размер по
 * умолчанию 16px; className h-* w-* масштабирует svg как обычно.
 */
export {
  ArrowsHorizontal as ArrowLeftRight,
  ArrowRight,
  Alarm,
  Calendar,
  Calculation as Calculator,
  Renew as Repeat,
  ChartBar as BarChart3,
  Checkmark as Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronSort as ChevronsUpDown,
  ChevronUp,
  ListChecked as ClipboardList,
  Download,
  Filter,
  Time as History,
  Home,
  DocumentBlank as Inbox,
  Menu,
  Money as Banknote,
  Package,
  Attachment as Paperclip,
  Edit as Pencil,
  Add as Plus,
  Receipt,
  Receipt as ReceiptText,
  Reset as RotateCcw,
  Scales as Scale,
  Plug,
  Search,
  ShoppingCart,
  SidePanelClose,
  SidePanelOpen,
  MagicWand as Sparkles,
  Tag,
  TrashCan as Trash2,
  Delivery as Truck,
  Upload,
  User as UserRound,
  UserMultiple as Users,
  Wallet,
  Close as X,
} from '@carbon/icons-react';

// Тип компонента-иконки (замена lucide `LucideIcon`).
export type { CarbonIconType, CarbonIconType as LucideIcon } from '@carbon/icons-react';
