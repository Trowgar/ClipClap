# ClipClap core top-quality evaluation — 2026-09-13

## Ответ на главные вопросы

На 49 парных реальных source новый `core-top-quality-v2` увеличивает число
publishable клипов в Top-3 с 85 до 87 из 147 фиксированных позиций
(57.82% → 59.18%), а в Top-5 — со 120 до 122 из 245 (48.98% → 49.80%).
Publishable clips/source выросли со 149/49 = 3.041 до 151/49 = 3.082.
Recall размеченных хороших моментов остался 25/41 = 60.98%; число пропусков
осталось 16. Precision не была улучшена ценой recall.

Крупнейшая оставшаяся системная потеря — episode construction и boundaries:
6 из 20 размеченных моментов, не попавших в publishable Top-3 финального
кандидата. Следом идёт ranking: 4 из 20. В этой итерации проверен консервативный
repair для случая, где critic удаляет короткий вопрос/setup. Безопасный вариант
не вернул дополнительную label, поэтому эта категория остаётся главным источником
потерь, а scanner repair не считается доказанным улучшением recall.

## 1. Исследованные реальные данные

Production snapshot за 1–12 сентября 2026 года содержит 72 job, 52 внешних
аккаунта, 58 уникальных source group, 213 сохранённых строк клипов и 70
транскриптов. Синтетические, административные, test и example аккаунты исключены.
Парный eval включает 31 development и 18 исходно отделённых holdout source — 49
source и 197 клипов финального кандидата. На 13 development source вручную
размечены 32 хороших момента, на 18 holdout — 9, всего 41.

Клиентский сигнал в выборке: 2 `AS_IS`, 10 `NO` и 6 запросов редактирования.
Покрытие этого feedback между live и candidate не изменилось: изменение не
выдаётся за успех только потому, что вспомогательный model review стал мягче.
Дополнительно отдельно измерены 18 клипов, добавленных предыдущим supplemental
recall: 14/18 publishable, 1 boring, 4 с плохой границей и 4 неполных. Это
подтверждает, что прирост предыдущего релиза был содержательным, но также указывает
на оставшуюся проблему цельности.

Для всех клипов использовались transcript, title/description, контекст до и после,
pipeline records и существующие разборы. Полный source media сохранился для 7
development и 12 holdout source; там проверялись готовые клипы и кадры. Отчёт не
утверждает, что каждое исходное видео было повторно просмотрено целиком со звуком.

Восемь ранее не прогонявшихся source (`b001`–`b008`) были запечатаны отдельно.
После открытия их результатов `b002` использовался для исправления обнаруженной
регрессии удаления publishable supplemental clip, поэтому этот набор больше не
считается независимым финальным holdout. Новых подходящих сентябрьских source на
момент проверки в production snapshot нет. Его результат приводится только как
regression set: Top-3 7/24 → 8/24, Top-5 9/40 → 9/40, publishable/source 1.125 →
1.125; человеческих moment labels в нём нет.

Blind-review скрывал engine version и rank. Стабильный salted ID строился из
геометрии, delivered copy и transcript; near-duplicate clustering не зависит от
порядка version/rank. Два model reviewer и adjudication использовались как
вспомогательный сигнал. При расхождении приоритет имеют клиентский feedback,
ручные moment labels и просмотр доступного media.

## 2. Основные failure modes

Трассировка live baseline для 41 хорошего момента дала 20 случаев без publishable
Top-3: episode/boundary — 5, ranking ниже Top-3 — 4, finalizer — 3, discovery — 3,
critic reject — 2, post-critic snap — 1, отсутствующий critic verdict — 1,
selection/NMS cap — 1.

Отдельно среди 17 непубликуемых development Top-3 live клипов 15 имели плохой
конец, 14 из них не доставляли обещанный payoff. Исходный arc audit при этом
помечал exit как корректный в 15 из 17 случаев: локально законченная последняя
фраза ошибочно принималась за завершённый эпизод.

Повторялись четыре причины:

- critic сужал начало до ответа и выбрасывал короткий вопрос/setup;
- finalizer повторно применял старый `broken_opening` после успешного repair;
- supplemental clip проходил с title/description, обещающими payoff за пределами
  фактического cut;
- широкое end extension пересекало сцену или вытесняло полезный клип, поэтому
  универсальное расширение boundaries оказалось небезопасным.

## 3. Где pipeline терял качество

Основная потеря возникает после положительного candidate/critic решения. В live
10 из 20 отсутствующих хороших Top-3 терялись после critic: episode/boundary 5,
finalizer 3, snap 1 и selection/NMS 1. Discovery отвечал за 3, ranking — за 4,
critic — за 2, пропущенный critic row — за 1.

В финальном кандидате осталось 20 пропущенных Top-3: episode/boundary 6, ranking
4, discovery 3, finalizer 2, critic 2, snap 1, отсутствующий verdict 1, NMS/cap 1.
Finalizer-потери сократились с трёх до двух, но episode/boundary остаётся
крупнейшей категорией и безопасный вариант не вернул дополнительные labels.

## 4. Изменения в коде

1. Добавлен post-final delivered-payoff audit точного доставляемого cut вместе с
   title/description. Он fail-open при технической ошибке.
2. Primary clip удаляется только при согласованных сигналах: исходный arc audit
   уже дал `standalone=false`, финальный audit подтверждает плохой exit и не может
   предложить безопасный `fixEndNode`.
3. Supplemental terminal failure теперь quarantine: такой клип остаётся ниже
   проверенных supplemental и не может заменить primary. Это устранило регрессию
   `b002`, где жёсткое удаление теряло publishable Top-5.
4. Добавлена защита repaired opening от устаревшего finalizer
   `broken_opening`, но только когда start действительно расширен, а exit и
   standalone чистые.
5. Добавлено scanner setup protection. Оно может вернуть не более двух узлов и
   восьми секунд вопроса/setup, удалённых critic, только внутри той же сцены, при
   чистом старте, прохождении hook gate, отсутствии NMS collision и max-duration
   нарушения. Wordless узел без отдельно подтверждённого onset не расширяется,
   даже если он первый в source. Каждый изменённый cut обязан пройти delivered-payoff audit; при
   отсутствующем или плохом verdict восстанавливается уже проверенная старая
   геометрия.
6. Analysis version выбирается из effective config. При выключении всех трёх
   новых флагов job снова получает `core-supplemental-recall-v1`, поэтому rollback
   корректен и по поведению, и по атрибуции.
7. Eval считает fixed-slot Top-3/Top-5 со знаменателем `sources × K`,
   publishable/source, recall и misses, boring, combined boundary, incomplete и
   cross-scene. Неполные structured responses отклоняются.

Новые механизмы закрыты точными opt-in флагами:

```text
ANALYZE_DELIVERED_PAYOFF_AUDIT_V1=on
ANALYZE_REPAIRED_OPENING_PROTECTION=on
ANALYZE_SCANNER_SETUP_PROTECTION_V1=on
```

## 5. Почему эти изменения работают

Измеренный прирост Top-3/Top-5 дают проверки фактического delivered cut и защита
уже repaired opening от устаревшего finalizer verdict. Audit оценивает финальную
геометрию вместе с обещанием title/description, а quarantine сохраняет recall:
сомнительный supplemental не поднимается вверх, но и не исчезает без достаточного
основания. Scanner setup repair размещён после finalizer и ограничен scanner span,
сценой, NMS, hook gate и надёжным onset; он безопасно сработал на `s071`, но не
дал измеримого прироста labels и потому остаётся экспериментальным. Все три
изменения выключаются независимо без миграции.

## 6. Eval: live и новая версия

| Набор | Метрика | Live | `core-top-quality-v2` | Δ |
| --- | --- | ---: | ---: | ---: |
| Development, 31 source | publishable Top-3 | 52/93 (55.91%) | 54/93 (58.06%) | +2 |
| Development | publishable Top-5 | 78/155 (50.32%) | 80/155 (51.61%) | +2 |
| Development | publishable/source | 3.032 | 3.097 | +0.065 |
| Development | moment recall | 21/32 | 21/32 | 0 |
| Development | bad boundary | 23/118 (19.49%) | 22/119 (18.49%) | -1.00 pp |
| Development | incomplete | 20/118 (16.95%) | 20/119 (16.81%) | -0.14 pp |
| Holdout, 18 source | publishable Top-3 | 33/54 (61.11%) | 33/54 (61.11%) | 0 |
| Holdout | publishable Top-5 | 42/90 (46.67%) | 42/90 (46.67%) | 0 |
| Holdout | publishable/source | 3.056 | 3.056 | 0 |
| Holdout | moment recall | 4/9 | 4/9 | 0 |
| Combined, 49 source | publishable Top-3 | 85/147 (57.82%) | 87/147 (59.18%) | +2 |
| Combined | publishable Top-5 | 120/245 (48.98%) | 122/245 (49.80%) | +2 |
| Combined | publishable/source | 3.041 | 3.082 | +0.041 |
| Combined | moment recall | 25/41 (60.98%) | 25/41 (60.98%) | 0 |

Combined boring rate меняется 12/196 = 6.12% → 12/197 = 6.09%, bad boundary
43/196 = 21.94% → 42/197 = 21.32%, incomplete 37/196 = 18.88% → 37/197 =
18.78%. Cross-scene в обеих версиях — 0.

Относительно ядра до supplemental recall совокупный результат двух итераций:
Top-3 79 → 87, Top-5 108 → 122, publishable/source 2.592 → 3.082, moment recall
22/41 → 25/41.

## 7. Holdout

На исходных 18 holdout source Top-3, Top-5, publishable/source и moment recall не
изменились. Небезопасное расширение wordless начала в `s011` было снято после
review: без точного onset нельзя доказать, что cut не начинается внутри слова.
Clip-level показатели совпали: 78 клипов, 55 publishable, 7 boring, 20 bad
boundary, 17 incomplete, 0 cross-scene.

Этот результат имеет ограничение: `s011` использовался после открытия holdout для
разработки setup protection. Поэтому набор остаётся честным парным измерением
реальных source, но уже не является статистически чистым финальным holdout для
последней итерации. Отдельный `b001`–`b008` также был открыт при исправлении
регрессии. Это ограничение нельзя устранить без новых реальных сентябрьских данных
и явно учитывается в решении о rollout.

## 8. Найденные regressions и их устранение

- Усиленный critic prompt снизил покрытие размеченных моментов на пилоте 3/11 →
  2/11; вариант отклонён.
- Универсальное end extension уменьшило число результатов 5 → 4 и не вернуло
  нужный момент; вариант отклонён.
- Жёсткое удаление supplemental terminal failure убрало publishable Top-5 в
  `b002`; заменено quarantine и запретом заменять primary.
- Раннее восстановление setup снова могло быть отменено finalizer; перенос после
  finalizer и обязательный post-final audit устранили этот путь.
- Blind dedup зависел от version/rank и мог раскрывать вариант reviewer; сортировка
  и connected clustering сделаны независимыми, payload проверяется байтовым
  тестом.
- Новая версия раньше писалась даже при выключенных флагах; effective-config
  version selection вернул корректный rollback attribution.

## Release verification

Targeted suite: 308/308 passed. Worker typecheck, shared build и worker build
завершились с exit 0. Финальный replay `v9` прошёл на всех 49 source; все запросы
воспроизвелись из точного cache, а изменившийся безопасный путь отдельно проверен
на `s011` и `s071`.

Полный worker suite: 2 913 passed, 53 failed. Новых failing test names относительно
live baseline нет; четыре прежних имени больше не падают. Оставшиеся failures —
stale/missing replay responses в `eval-snapshot` и вложенный Docker-вызов, которого
нет внутри test container. Fixtures не перезаписывались ради зелёного отчёта.
Suite остаётся не all-green, а независимый holdout отсутствует. Эти ограничения
сохранены как известный риск релиза и не переопределяют результаты парного replay.

## 9. Production

13 сентября 2026 года выполнен owner-approved rollout с явно принятым риском
неполностью независимого holdout. Production-ветка fast-forward обновлена с
`a9fabbd` до `63962e0`; включены `ANALYZE_DELIVERED_PAYOFF_AUDIT_V1`,
`ANALYZE_REPAIRED_OPENING_PROTECTION` и
`ANALYZE_SCANNER_SETUP_PROTECTION_V1`. Effective config внутри analyze-worker
сообщил `recall-critic`, все три флага `true` и analysis version
`core-top-quality-v2`.

Во время rollout analyze queue была приостановлена уже пустой (active/waiting =
0/0), после smoke-check возобновлена и осталась пустой. Пересоздан только
`worker-analyze`; Prisma Client и shared package собраны в контейнере. Контейнер
работает с restart count 0, OOM=false, ошибок запуска в свежих логах нет.

Rollback: выключить три флага, вернуть production-ветку на сохранённую
`rollback/core-live-2026-09-13-a9fabbd` и recreate только analyze-worker с тем же
compose overlay. Предрелизная `.env` сохранена приватно; schema и миграции не
менялись.

## 10. Следующие приоритеты

1. Scene-aware episode construction и boundary selection для оставшихся 6/20
   пропущенных Top-3 моментов, прежде всего visual payoff после текста.
2. Ranking для 4/20: поднять уже publishable хорошие моменты без удаления текущих
   результатов.
3. Discovery для 3/19 коротких payoff внутри длинных source.
4. Два ложных critic reject и один отсутствующий critic verdict.
5. Собрать новый нетронутый клиентский holdout и связать post-release feedback с
   `analysisVersion`, чтобы следующий gate опирался на свежий человеческий сигнал.
